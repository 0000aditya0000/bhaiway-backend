import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../../auth/auth.module';
import { AuthService } from '../../auth/auth.service';
import { Msg91ResponseFormatError } from '../../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../../auth/providers/otp-provider.interface';
import { UsersModule } from '../../users/users.module';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { WalletBalance } from '../../wallet/entities/wallet-balance.entity';
import { WalletModule } from '../../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../../wallet/test/wallet-test.helpers';
import { TrustedContact } from './entities/trusted-contact.entity';
import { TrustedContactRelationship } from './enums/trusted-contact-relationship.enum';
import { SafetyModule } from '../safety.module';

describe('Trusted contacts (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: process.env.DATABASE_URL,
          autoLoadEntities: true,
          synchronize: false,
          logging: false,
        }),
        AuthModule,
        UsersModule,
        WalletModule,
        SafetyModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new Msg91ResponseFormatError()),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    authService = moduleRef.get(AuthService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.query(
          `DELETE FROM trusted_contacts WHERE user_id = $1`,
          [ctx.userId],
        );
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  async function registerUser() {
    const phone = `+91${Date.now().toString().slice(-10)}${Math.floor(
      Math.random() * 10,
    )}`;
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });
    const wallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId: login.user.id });
    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    tracked.push({
      userId: login.user.id,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });
    return login;
  }

  const baseContact = {
    name: 'Rahul Gangwar',
    phoneNumber: '+919876543210',
    relationship: TrustedContactRelationship.BROTHER,
  };

  it('creates a trusted contact owned by JWT user', async () => {
    const user = await registerUser();
    const uniquePhone = `+9198${Date.now().toString().slice(-8)}`;

    const res = await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ...baseContact, phoneNumber: uniquePhone })
      .expect(201);

    expect(res.body).toMatchObject({
      name: 'Rahul Gangwar',
      phoneNumber: uniquePhone,
      relationship: 'BROTHER',
      photoUrl: null,
    });
    expect(res.body.id).toBeTruthy();
    expect(res.body).not.toHaveProperty('userId');

    const row = await dataSource
      .getRepository(TrustedContact)
      .findOneByOrFail({ id: res.body.id });
    expect(row.userId).toBe(user.user.id);
  });

  it('rejects userId in body and invalid payloads', async () => {
    const user = await registerUser();

    await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ...baseContact, userId: user.user.id })
      .expect(400);

    const badName = await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ...baseContact, name: 'A', phoneNumber: '+919811122233' })
      .expect(400);
    expect(JSON.stringify(badName.body)).toMatch(/name/i);

    const badPhone = await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ...baseContact, phoneNumber: '12345' })
      .expect(422);
    expect(badPhone.body.code).toBe('INVALID_TRUSTED_CONTACT_PHONE');

    await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ...baseContact, relationship: 'COUSIN' })
      .expect(400);
  });

  it('normalizes phone and treats photo as optional', async () => {
    const user = await registerUser();
    const res = await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        name: 'Anita',
        phoneNumber: '98 7654 3211',
        relationship: TrustedContactRelationship.SISTER,
        photoUrl: 'https://cdn.example/photo.jpg',
      })
      .expect(201);

    expect(res.body.phoneNumber).toBe('+919876543211');
    expect(res.body.photoUrl).toBe('https://cdn.example/photo.jpg');
  });

  it('rejects duplicate phone and enforces max contacts', async () => {
    const user = await registerUser();
    const phone = `+9197${Date.now().toString().slice(-8)}`;

    await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ...baseContact, phoneNumber: phone })
      .expect(201);

    const dup = await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ...baseContact, name: 'Other', phoneNumber: phone })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE_TRUSTED_CONTACT');

    // Fill to default max (5) including the one already created.
    for (let i = 0; i < 4; i += 1) {
      await request(app.getHttpServer())
        .post('/safety/trusted-contacts')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          name: `Contact ${i}`,
          phoneNumber: `+9196${String(Date.now()).slice(-7)}${i}`,
          relationship: TrustedContactRelationship.FRIEND,
        })
        .expect(201);
    }

    const limited = await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        name: 'Overflow',
        phoneNumber: `+9195${Date.now().toString().slice(-8)}`,
        relationship: TrustedContactRelationship.FRIEND,
      })
      .expect(422);
    expect(limited.body.code).toBe('TRUSTED_CONTACT_LIMIT_REACHED');
  });

  it('lists only own contacts newest first; hides others', async () => {
    const a = await registerUser();
    const b = await registerUser();

    const first = await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({
        name: 'Older',
        phoneNumber: `+9194${Date.now().toString().slice(-8)}`,
        relationship: TrustedContactRelationship.FRIEND,
      })
      .expect(201);

    await new Promise((r) => setTimeout(r, 20));

    const second = await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({
        name: 'Newer',
        phoneNumber: `+9193${Date.now().toString().slice(-8)}`,
        relationship: TrustedContactRelationship.PARENT,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({
        name: 'B Only',
        phoneNumber: `+9192${Date.now().toString().slice(-8)}`,
        relationship: TrustedContactRelationship.COLLEAGUE,
      })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/safety/trusted-contacts?page=1&limit=20')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);

    expect(list.body.total).toBe(2);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0].id).toBe(second.body.id);
    expect(list.body.items[1].id).toBe(first.body.id);
    expect(list.body.items.every((i: { name: string }) => i.name !== 'B Only'))
      .toBe(true);
  });

  it('get/update/delete enforce ownership; soft delete hides from list', async () => {
    const a = await registerUser();
    const b = await registerUser();

    const created = await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({
        name: 'Mine',
        phoneNumber: `+9191${Date.now().toString().slice(-8)}`,
        relationship: TrustedContactRelationship.SPOUSE,
      })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/safety/trusted-contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);

    const foreign = await request(app.getHttpServer())
      .get(`/safety/trusted-contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(404);
    expect(foreign.body.code).toBe('TRUSTED_CONTACT_NOT_FOUND');

    await request(app.getHttpServer())
      .patch(`/safety/trusted-contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ name: 'Hacked' })
      .expect(404);

    const updated = await request(app.getHttpServer())
      .patch(`/safety/trusted-contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ name: 'Updated Name', relationship: TrustedContactRelationship.PARTNER })
      .expect(200);
    expect(updated.body.name).toBe('Updated Name');
    expect(updated.body.relationship).toBe('PARTNER');

    await request(app.getHttpServer())
      .delete(`/safety/trusted-contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/safety/trusted-contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(204);

    const list = await request(app.getHttpServer())
      .get('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(list.body.total).toBe(0);

    await request(app.getHttpServer())
      .get(`/safety/trusted-contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(404);

    // Soft-deleted phone can be re-added.
    await request(app.getHttpServer())
      .post('/safety/trusted-contacts')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({
        name: 'Readded',
        phoneNumber: created.body.phoneNumber,
        relationship: TrustedContactRelationship.FRIEND,
      })
      .expect(201);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .get('/safety/trusted-contacts')
      .expect(401);
  });
});
