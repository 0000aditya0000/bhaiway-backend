import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { UserPaymentMethod } from './entities/user-payment-method.entity';
import { Withdrawal } from './entities/withdrawal.entity';
import { PaymentMethodType, WithdrawalStatus } from './enums/withdrawal.enums';
import {
  decryptAccountNumber,
  encryptAccountNumber,
  maskAccountNumber,
} from './payment-method-crypto.util';
import {
  bearer,
  cleanupWithdrawalTestWallet,
  createTestWallet,
  createWithdrawalTestEnv,
  WithdrawalTestEnv,
} from './test/withdrawal-test.helpers';
import { TestWalletContext } from './test/wallet-test.helpers';

jest.setTimeout(60_000);

describe('payment-method crypto util', () => {
  it('round-trips AES-256-GCM and never returns plaintext in ciphertext', () => {
    const cipher = encryptAccountNumber('123456789012', 'secret-1');
    expect(cipher).not.toContain('123456789012');
    expect(decryptAccountNumber(cipher, 'secret-1')).toBe('123456789012');
  });

  it('uses a random IV per encryption', () => {
    expect(encryptAccountNumber('123456789012', 's')).not.toBe(
      encryptAccountNumber('123456789012', 's'),
    );
  });

  it('fails closed on wrong key or tampered data', () => {
    const cipher = encryptAccountNumber('123456789012', 'secret-1');
    expect(decryptAccountNumber(cipher, 'secret-2')).toBeNull();
    const tampered = `${cipher.slice(0, -2)}${cipher.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(decryptAccountNumber(tampered, 'secret-1')).toBeNull();
    expect(decryptAccountNumber('short', 'secret-1')).toBeNull();
  });

  it('masks account numbers with last4 only', () => {
    expect(maskAccountNumber('9012')).toBe('XXXX XXXX 9012');
    expect(maskAccountNumber('12')).toBe('XXXX XXXX XX12');
    expect(maskAccountNumber(null)).toBe('XXXX XXXX XXXX');
  });
});

describe('Payment methods API (integration)', () => {
  let env: WithdrawalTestEnv;
  let app: INestApplication;
  let dataSource: DataSource;
  let secret: string;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    env = await createWithdrawalTestEnv();
    app = env.app;
    dataSource = env.dataSource;
    const config = env.moduleRef.get(ConfigService);
    secret =
      config.get<string>('ENCRYPTION_KEY') ||
      config.get<string>('JWT_ACCESS_SECRET') ||
      '';
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await cleanupWithdrawalTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  async function spawnUser(): Promise<{ ctx: TestWalletContext; auth: string }> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return { ctx, auth: bearer(env.jwtService, ctx.userId) };
  }

  const bankBody = {
    type: 'BANK_ACCOUNT',
    accountHolderName: 'Asha Verma',
    accountNumber: '123456789012',
    ifscCode: 'hdfc0001234',
    bankName: 'HDFC Bank',
  };

  function post(auth: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/wallet/payment-methods')
      .set('Authorization', auth)
      .send(body);
  }

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/wallet/payment-methods').expect(401);
    await request(app.getHttpServer())
      .post('/wallet/payment-methods')
      .send({ type: 'UPI', upiId: 'a@b' })
      .expect(401);
  });

  describe('UPI', () => {
    it('creates a UPI method (trimmed + lower-cased)', async () => {
      const { auth, ctx } = await spawnUser();
      const res = await post(auth, {
        type: 'UPI',
        upiId: '  Asha.Verma@OkBank ',
      }).expect(201);

      expect(res.body).toMatchObject({
        type: PaymentMethodType.UPI,
        upiId: 'asha.verma@okbank',
        accountNumberMasked: null,
        isActive: true,
      });
      const row = await dataSource
        .getRepository(UserPaymentMethod)
        .findOneByOrFail({ id: res.body.id });
      expect(row.userId).toBe(ctx.userId);
    });

    it.each(['', 'nohandle', 'a@b', '@bank', 'a b@bank', 'name@', 'x@@y'])(
      'rejects invalid UPI %p with INVALID_PAYMENT_METHOD',
      async (upiId) => {
        const { auth } = await spawnUser();
        const res = await post(auth, { type: 'UPI', upiId }).expect(400);
        expect(res.body.code).toBe('INVALID_PAYMENT_METHOD');
      },
    );

    it('returns the existing active method for a duplicate UPI (case-insensitive)', async () => {
      const { auth, ctx } = await spawnUser();
      const first = await post(auth, { type: 'UPI', upiId: 'dup@okbank' }).expect(
        201,
      );
      const second = await post(auth, { type: 'UPI', upiId: 'DUP@OKBANK' });
      expect([200, 201]).toContain(second.status);
      expect(second.body.id).toBe(first.body.id);

      const count = await dataSource
        .getRepository(UserPaymentMethod)
        .count({ where: { userId: ctx.userId } });
      expect(count).toBe(1);
    });

    it('does not dedupe the same UPI across different users', async () => {
      const a = await spawnUser();
      const b = await spawnUser();
      const first = await post(a.auth, { type: 'UPI', upiId: 'shared@okbank' });
      const second = await post(b.auth, { type: 'UPI', upiId: 'shared@okbank' });
      expect(first.body.id).not.toBe(second.body.id);
    });
  });

  describe('bank account', () => {
    it('creates, masks, and encrypts the account number', async () => {
      const { auth } = await spawnUser();
      const res = await post(auth, bankBody).expect(201);

      expect(res.body).toMatchObject({
        type: PaymentMethodType.BANK_ACCOUNT,
        accountHolderName: 'Asha Verma',
        accountNumberMasked: 'XXXX XXXX 9012',
        accountNumberLast4: '9012',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
        upiId: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('123456789012');
      expect(res.body).not.toHaveProperty('accountNumber');
      expect(res.body).not.toHaveProperty('accountNumberEncrypted');

      const row = await dataSource
        .getRepository(UserPaymentMethod)
        .findOneByOrFail({ id: res.body.id });
      expect(row.accountNumberEncrypted).toBeTruthy();
      expect(row.accountNumberEncrypted).not.toContain('123456789012');
      expect(decryptAccountNumber(row.accountNumberEncrypted as string, secret)).toBe(
        '123456789012',
      );
    });

    it.each([
      ['short account (8 digits)', { accountNumber: '12345678' }],
      ['long account (19 digits)', { accountNumber: '1234567890123456789' }],
      ['alphabetic account', { accountNumber: '12345abcd678' }],
      ['bad IFSC', { ifscCode: 'HDFC1001234' }],
      ['short IFSC', { ifscCode: 'HDFC000' }],
      ['blank holder', { accountHolderName: ' ' }],
      ['blank bank name', { bankName: '' }],
    ])('rejects %s', async (_label, override) => {
      const { auth } = await spawnUser();
      const res = await post(auth, { ...bankBody, ...override }).expect(400);
      expect(res.body.code).toBe('INVALID_PAYMENT_METHOD');
    });

    it('rejects a missing bank field', async () => {
      const { auth } = await spawnUser();
      const { bankName: _omit, ...withoutBank } = bankBody;
      const res = await post(auth, withoutBank).expect(400);
      expect(res.body.code).toBe('INVALID_PAYMENT_METHOD');
    });

    it('rejects unknown type / unknown properties', async () => {
      const { auth } = await spawnUser();
      await post(auth, { type: 'CRYPTO' }).expect(400);
      await post(auth, { ...bankBody, hacker: 1 }).expect(400);
    });

    it('returns the existing method for an identical bank account', async () => {
      const { auth, ctx } = await spawnUser();
      const first = await post(auth, bankBody).expect(201);
      const second = await post(auth, {
        ...bankBody,
        accountHolderName: 'ASHA VERMA',
        ifscCode: 'HDFC0001234',
      });
      expect([200, 201]).toContain(second.status);
      expect(second.body.id).toBe(first.body.id);
      expect(
        await dataSource
          .getRepository(UserPaymentMethod)
          .count({ where: { userId: ctx.userId } }),
      ).toBe(1);
    });

    it('treats a different account number with the same last4 as a new method', async () => {
      const { auth } = await spawnUser();
      const first = await post(auth, bankBody).expect(201);
      const second = await post(auth, {
        ...bankBody,
        accountNumber: '999999999012',
      }).expect(201);
      expect(second.body.id).not.toBe(first.body.id);
    });
  });

  describe('list / get / update / delete', () => {
    it('lists only own active methods', async () => {
      const a = await spawnUser();
      const b = await spawnUser();
      const mine = await post(a.auth, { type: 'UPI', upiId: 'mine@okbank' });
      await post(b.auth, { type: 'UPI', upiId: 'theirs@okbank' });
      const inactive = await post(a.auth, bankBody);
      await dataSource
        .getRepository(UserPaymentMethod)
        .update({ id: inactive.body.id }, { isActive: false });

      const res = await request(app.getHttpServer())
        .get('/wallet/payment-methods')
        .set('Authorization', a.auth)
        .expect(200);
      expect(res.body.map((m: { id: string }) => m.id)).toEqual([mine.body.id]);
    });

    it('GET /:id returns own method; other users get PAYMENT_METHOD_NOT_FOUND', async () => {
      const a = await spawnUser();
      const b = await spawnUser();
      const created = await post(a.auth, bankBody).expect(201);

      const ok = await request(app.getHttpServer())
        .get(`/wallet/payment-methods/${created.body.id}`)
        .set('Authorization', a.auth)
        .expect(200);
      expect(ok.body.accountNumberMasked).toBe('XXXX XXXX 9012');

      for (const method of ['get', 'patch', 'delete'] as const) {
        const res = await request(app.getHttpServer())
          [method](`/wallet/payment-methods/${created.body.id}`)
          .set('Authorization', b.auth)
          .send(method === 'patch' ? { bankName: 'Hack' } : undefined)
          .expect(404);
        expect(res.body.code).toBe('PAYMENT_METHOD_NOT_FOUND');
      }
    });

    it('PATCH updates fields and re-encrypts a new account number', async () => {
      const { auth } = await spawnUser();
      const created = await post(auth, bankBody).expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/wallet/payment-methods/${created.body.id}`)
        .set('Authorization', auth)
        .send({ bankName: 'ICICI Bank', accountNumber: '555566667777', ifscCode: 'icic0000123' })
        .expect(200);

      expect(res.body).toMatchObject({
        bankName: 'ICICI Bank',
        accountNumberMasked: 'XXXX XXXX 7777',
        ifscCode: 'ICIC0000123',
      });
      const row = await dataSource
        .getRepository(UserPaymentMethod)
        .findOneByOrFail({ id: created.body.id });
      expect(decryptAccountNumber(row.accountNumberEncrypted as string, secret)).toBe(
        '555566667777',
      );
    });

    it('PATCH validates input', async () => {
      const { auth } = await spawnUser();
      const created = await post(auth, bankBody).expect(201);
      const res = await request(app.getHttpServer())
        .patch(`/wallet/payment-methods/${created.body.id}`)
        .set('Authorization', auth)
        .send({ accountNumber: '12' })
        .expect(400);
      expect(res.body.code).toBe('INVALID_PAYMENT_METHOD');
    });

    it('DELETE hard-deletes a method that was never used', async () => {
      const { auth } = await spawnUser();
      const created = await post(auth, bankBody).expect(201);

      const res = await request(app.getHttpServer())
        .delete(`/wallet/payment-methods/${created.body.id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(res.body).toEqual({
        id: created.body.id,
        deleted: true,
        deactivated: false,
      });
      expect(
        await dataSource
          .getRepository(UserPaymentMethod)
          .findOneBy({ id: created.body.id }),
      ).toBeNull();
    });

    it('DELETE soft-deactivates a method referenced by a withdrawal', async () => {
      const { auth, ctx } = await spawnUser();
      const created = await post(auth, bankBody).expect(201);
      const method = await dataSource
        .getRepository(UserPaymentMethod)
        .findOneByOrFail({ id: created.body.id });

      await dataSource.getRepository(Withdrawal).save(
        dataSource.getRepository(Withdrawal).create({
          userId: ctx.userId,
          walletId: ctx.walletId,
          amount: '10',
          status: WithdrawalStatus.INITIATED,
          provider: 'MANUAL',
          paymentMethodId: method.id,
          paymentMethodType: method.type,
          paymentMethodSnapshot: {
            type: method.type,
            upiId: null,
            accountHolderName: method.accountHolderName,
            accountNumberEncrypted: method.accountNumberEncrypted,
            accountNumberLast4: method.accountNumberLast4,
            ifscCode: method.ifscCode,
            bankName: method.bankName,
          },
          referenceId: `WD-T${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
          idempotencyKey: `pm-ref-${Date.now()}`,
        }),
      );

      const res = await request(app.getHttpServer())
        .delete(`/wallet/payment-methods/${created.body.id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(res.body).toEqual({
        id: created.body.id,
        deleted: false,
        deactivated: true,
      });

      const row = await dataSource
        .getRepository(UserPaymentMethod)
        .findOneByOrFail({ id: created.body.id });
      expect(row.isActive).toBe(false);

      const list = await request(app.getHttpServer())
        .get('/wallet/payment-methods')
        .set('Authorization', auth)
        .expect(200);
      expect(list.body).toEqual([]);

      await request(app.getHttpServer())
        .get(`/wallet/payment-methods/${created.body.id}`)
        .set('Authorization', auth)
        .expect(404);
    });
  });
});
