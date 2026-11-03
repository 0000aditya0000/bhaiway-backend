import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { PhoneAlreadyRegisteredError } from '../auth/errors/phone-already-registered.error';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { RatingsModule } from '../ratings/ratings.module';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { UserProfile } from './entities/user-profile.entity';
import { User, UserStatus } from './entities/user.entity';
import { UsersModule } from './users.module';

describe('Registration & Profile Data Persistence with Cloudinary (Integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let userRepo: Repository<User>;
  let profileRepo: Repository<UserProfile>;
  let walletRepo: Repository<Wallet>;
  let verifyAccessTokenMock: jest.Mock;
  const tracked: TestWalletContext[] = [];

  const validCloudinaryUrl =
    'https://res.cloudinary.com/bhaiway/image/upload/v1700000000/profiles/avatar_1.jpg';
  const updatedCloudinaryUrl =
    'https://res.cloudinary.com/bhaiway/image/upload/v1700000001/profiles/avatar_2.jpg';

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    verifyAccessTokenMock = jest.fn();

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
        RatingsModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        verifyAccessToken: verifyAccessTokenMock,
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
    userRepo = dataSource.getRepository(User);
    profileRepo = dataSource.getRepository(UserProfile);
    walletRepo = dataSource.getRepository(Wallet);
  });

  afterEach(async () => {
    verifyAccessTokenMock.mockReset();
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  function makeUniquePhone(): string {
    return `+91${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 10)}`;
  }

  describe('Scenario 1: New registration saves name, email and Cloudinary profile photo', () => {
    it('persists name, email, and Cloudinary photo and returns them in auth response', async () => {
      const phone = makeUniquePhone();
      const rawEmail = '  NewUser.Registration@Example.COM  ';

      const res = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        email: rawEmail,
        isRegistration: true,
        name: 'Aditya Gangwar',
        profilePhoto: validCloudinaryUrl,
      });

      const wallet = await walletRepo.findOneByOrFail({ userId: res.user.id });
      tracked.push({
        userId: res.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Verify Auth Login response
      expect(res.user.email).toBe('newuser.registration@example.com');
      expect(res.user.emailVerified).toBe(false);
      expect(res.user.profilePhoto).toBe(validCloudinaryUrl);
      expect(res.user.name).toBe('Aditya Gangwar');
      expect(res.user.firstName).toBe('Aditya');
      expect(res.user.lastName).toBe('Gangwar');
      expect(res.user.profileCompleted).toBe(true);

      // Verify User record in DB
      const savedUser = await userRepo.findOneByOrFail({ id: res.user.id });
      expect(savedUser.email).toBe('newuser.registration@example.com');
      expect(savedUser.emailVerified).toBe(false);

      // Verify UserProfile record in DB
      const savedProfile = await profileRepo.findOneByOrFail({
        userId: res.user.id,
      });
      expect(savedProfile.firstName).toBe('Aditya');
      expect(savedProfile.lastName).toBe('Gangwar');
      expect(savedProfile.displayName).toBe('Aditya Gangwar');
      expect(savedProfile.profilePhoto).toBe(validCloudinaryUrl);
    });

    it('persists name, email, and Cloudinary photo via HTTP POST /auth/register', async () => {
      const phone = makeUniquePhone();
      verifyAccessTokenMock.mockResolvedValueOnce({
        phone,
        verified: true,
      });

      const res = await request(app.getHttpServer() as never)
        .post('/auth/register')
        .send({
          accessToken: 'valid_mock_token',
          name: 'Priya Sharma',
          email: 'Priya.Sharma@Example.com',
          profilePhoto: validCloudinaryUrl,
        })
        .expect(200);

      const wallet = await walletRepo.findOneByOrFail({
        userId: res.body.user.id,
      });
      tracked.push({
        userId: res.body.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      expect(res.body.user.email).toBe('priya.sharma@example.com');
      expect(res.body.user.profilePhoto).toBe(validCloudinaryUrl);
      expect(res.body.user.name).toBe('Priya Sharma');
      expect(res.body.user.firstName).toBe('Priya');
      expect(res.body.user.lastName).toBe('Sharma');
      expect(res.body.user.profileCompleted).toBe(true);
    });
  });

  describe('Scenario 2: Missing email displays the correct state in the frontend API response', () => {
    it('creates user with null email and emailVerified false when email is omitted', async () => {
      const phone = makeUniquePhone();

      const res = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        isRegistration: true,
        profilePhoto: validCloudinaryUrl,
      });

      const wallet = await walletRepo.findOneByOrFail({ userId: res.user.id });
      tracked.push({
        userId: res.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      expect(res.user.email).toBeNull();
      expect(res.user.emailVerified).toBe(false);
      expect(res.user.profilePhoto).toBe(validCloudinaryUrl);

      const savedUser = await userRepo.findOneByOrFail({ id: res.user.id });
      expect(savedUser.email).toBeNull();
      expect(savedUser.emailVerified).toBe(false);
    });
  });

  describe('Scenario 3: Email verification status is preserved correctly', () => {
    it('leaves emailVerified false on registration and rejects overwriting an already verified email', async () => {
      const phone = makeUniquePhone();
      const res = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        email: 'original@example.com',
        isRegistration: true,
      });

      const wallet = await walletRepo.findOneByOrFail({ userId: res.user.id });
      tracked.push({
        userId: res.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Mark email as verified manually in DB
      await userRepo.update(res.user.id, { emailVerified: true });

      // Attempt to change verified email via createProfile should fail with 409
      await request(app.getHttpServer() as never)
        .post('/users/profile')
        .set('Authorization', `Bearer ${res.accessToken}`)
        .send({
          firstName: 'Verified',
          lastName: 'User',
          email: 'attempted.overwrite@example.com',
          profilePhoto: validCloudinaryUrl,
        })
        .expect(409);

      // Verify that the email was NOT changed and remains verified
      const userAfter = await userRepo.findOneByOrFail({ id: res.user.id });
      expect(userAfter.email).toBe('original@example.com');
      expect(userAfter.emailVerified).toBe(true);
    });

    it('rejects duplicate email if already in use by another active account', async () => {
      const phone1 = makeUniquePhone();
      const user1 = await authService.loginOrRegisterWithVerifiedIdentity({
        phone: phone1,
        verified: true,
        email: 'shared@example.com',
      });
      const wallet1 = await walletRepo.findOneByOrFail({
        userId: user1.user.id,
      });
      tracked.push({
        userId: user1.user.id,
        walletId: wallet1.id,
        balanceId: 'pending',
        phone: phone1,
      });

      const phone2 = makeUniquePhone();
      const user2 = await authService.loginOrRegisterWithVerifiedIdentity({
        phone: phone2,
        verified: true,
      });
      const wallet2 = await walletRepo.findOneByOrFail({
        userId: user2.user.id,
      });
      tracked.push({
        userId: user2.user.id,
        walletId: wallet2.id,
        balanceId: 'pending',
        phone: phone2,
      });

      // User 2 tries to set the same email on profile creation
      await request(app.getHttpServer() as never)
        .post('/users/profile')
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({
          firstName: 'Second',
          lastName: 'User',
          email: 'shared@example.com',
          profilePhoto: validCloudinaryUrl,
        })
        .expect(409);
    });
  });

  describe('Scenario 4: Cloudinary URL validation and local URI rejection', () => {
    it('rejects non-Cloudinary HTTPS URLs on registration with 400 Bad Request', async () => {
      const phone = makeUniquePhone();
      verifyAccessTokenMock.mockResolvedValueOnce({
        phone,
        verified: true,
      });

      const res = await request(app.getHttpServer() as never)
        .post('/auth/register')
        .send({
          accessToken: 'valid_mock_token',
          name: 'Attacker',
          profilePhoto: 'https://evil-storage.com/photo.jpg',
        })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain(
        'must be a valid HTTPS Cloudinary secure_url',
      );
    });

    it('rejects URLs for a different Cloudinary cloud with 400 Bad Request', async () => {
      const phone = makeUniquePhone();
      verifyAccessTokenMock.mockResolvedValueOnce({
        phone,
        verified: true,
      });

      const res = await request(app.getHttpServer() as never)
        .post('/auth/register')
        .send({
          accessToken: 'valid_mock_token',
          name: 'Attacker',
          profilePhoto:
            'https://res.cloudinary.com/attackercloud/image/upload/v123/photo.jpg',
        })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain(
        'must be a valid HTTPS Cloudinary secure_url',
      );
    });

    it('rejects HTTP (non-secure) Cloudinary URLs with 400 Bad Request', async () => {
      const phone = makeUniquePhone();
      verifyAccessTokenMock.mockResolvedValueOnce({
        phone,
        verified: true,
      });

      const res = await request(app.getHttpServer() as never)
        .post('/auth/register')
        .send({
          accessToken: 'valid_mock_token',
          name: 'Insecure',
          profilePhoto:
            'http://res.cloudinary.com/bhaiway/image/upload/v123/photo.jpg',
        })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain(
        'must be a valid HTTPS Cloudinary secure_url',
      );
    });

    it('rejects local file:// URIs on POST /users/profile with 400 Bad Request', async () => {
      const phone = makeUniquePhone();
      const login = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
      });
      const wallet = await walletRepo.findOneByOrFail({
        userId: login.user.id,
      });
      tracked.push({
        userId: login.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      const res = await request(app.getHttpServer() as never)
        .post('/users/profile')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({
          firstName: 'Local',
          lastName: 'File',
          profilePhoto: 'file:///data/user/0/com.bhaiway/cache/avatar.jpg',
        })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('Cloudinary');
    });

    it('rejects content:// URIs on PATCH /users/profile with 400 Bad Request', async () => {
      const phone = makeUniquePhone();
      const login = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
      });
      const wallet = await walletRepo.findOneByOrFail({
        userId: login.user.id,
      });
      tracked.push({
        userId: login.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Create valid profile first
      await request(app.getHttpServer() as never)
        .post('/users/profile')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({
          firstName: 'Valid',
          lastName: 'Profile',
          profilePhoto: validCloudinaryUrl,
        })
        .expect(201);

      // Attempt update with content:// URI
      const res = await request(app.getHttpServer() as never)
        .patch('/users/profile')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({
          profilePhoto: 'content://media/external/images/media/1234',
        })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('Cloudinary');
    });
  });

  describe('Scenario 5: Profile GET returns saved email and Cloudinary photo', () => {
    it('returns email, emailVerified and profilePhoto on GET /users/profile and GET /users/me', async () => {
      const phone = makeUniquePhone();
      const login = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        email: 'profile.get@example.com',
        profilePhoto: validCloudinaryUrl,
        name: 'GetTest User',
      });
      const wallet = await walletRepo.findOneByOrFail({
        userId: login.user.id,
      });
      tracked.push({
        userId: login.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Test GET /users/profile
      const getProfileRes = await request(app.getHttpServer() as never)
        .get('/users/profile')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(getProfileRes.body).toMatchObject({
        firstName: 'GetTest',
        lastName: 'User',
        email: 'profile.get@example.com',
        emailVerified: false,
        profilePhoto: validCloudinaryUrl,
      });

      // Test GET /users/me/profile
      const getMeProfileRes = await request(app.getHttpServer() as never)
        .get('/users/me/profile')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(getMeProfileRes.body.profilePhoto).toBe(validCloudinaryUrl);
      expect(getMeProfileRes.body.email).toBe('profile.get@example.com');

      // Test GET /users/me
      const getMeRes = await request(app.getHttpServer() as never)
        .get('/users/me')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(getMeRes.body.user.email).toBe('profile.get@example.com');
      expect(getMeRes.body.user.emailVerified).toBe(false);
      expect(getMeRes.body.profile.profilePhoto).toBe(validCloudinaryUrl);
    });
  });

  describe('Scenario 6: Updating a photo changes the saved URL', () => {
    it('updates the Cloudinary URL via PATCH /users/profile', async () => {
      const phone = makeUniquePhone();
      const login = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        name: 'Update Tester',
        profilePhoto: validCloudinaryUrl,
      });
      const wallet = await walletRepo.findOneByOrFail({
        userId: login.user.id,
      });
      tracked.push({
        userId: login.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Update photo to a new Cloudinary URL
      const patchRes = await request(app.getHttpServer() as never)
        .patch('/users/profile')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({
          profilePhoto: updatedCloudinaryUrl,
        })
        .expect(200);

      expect(patchRes.body.profilePhoto).toBe(updatedCloudinaryUrl);

      // Verify DB record updated
      const profileInDb = await profileRepo.findOneByOrFail({
        userId: login.user.id,
      });
      expect(profileInDb.profilePhoto).toBe(updatedCloudinaryUrl);
    });
  });

  describe('Scenario 7: Login returns the existing saved profile photo', () => {
    it('returns the existing saved Cloudinary profile photo upon OTP login', async () => {
      const phone = makeUniquePhone();
      const first = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        name: 'Existing User',
        profilePhoto: validCloudinaryUrl,
      });
      const wallet = await walletRepo.findOneByOrFail({
        userId: first.user.id,
      });
      tracked.push({
        userId: first.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Subsequent login
      const second = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        isRegistration: false,
      });

      expect(second.user.id).toBe(first.user.id);
      expect(second.user.profilePhoto).toBe(validCloudinaryUrl);
      expect(second.user.name).toBe('Existing User');
      expect(second.user.profileCompleted).toBe(true);
    });
  });

  describe('Scenario 8 & 9: Duplicate active phone registration returns 409 Conflict', () => {
    it('rejects registration with 409 PHONE_ALREADY_REGISTERED and does not create duplicate user', async () => {
      const phone = makeUniquePhone();
      const existing = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
      });
      const wallet = await walletRepo.findOneByOrFail({
        userId: existing.user.id,
      });
      tracked.push({
        userId: existing.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      const initialCount = await userRepo.count({ where: { phone } });
      expect(initialCount).toBe(1);

      // Direct service call with isRegistration: true
      await expect(
        authService.loginOrRegisterWithVerifiedIdentity({
          phone,
          verified: true,
          isRegistration: true,
        }),
      ).rejects.toThrow(PhoneAlreadyRegisteredError);

      // sendMsg91Otp with isRegistration: true
      await expect(
        authService.sendMsg91Otp(phone, { isRegistration: true }),
      ).rejects.toThrow(PhoneAlreadyRegisteredError);

      // HTTP endpoint POST /auth/register
      verifyAccessTokenMock.mockResolvedValueOnce({
        type: 'success',
        phone,
      });

      const httpRes = await request(app.getHttpServer() as never)
        .post('/auth/register')
        .send({
          accessToken: 'valid_mock_token',
        })
        .expect(409);

      expect(httpRes.body).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: 'PHONE_ALREADY_REGISTERED',
        message: 'Number already registered. Please login.',
      });

      // Verify no duplicate was created
      const finalCount = await userRepo.count({ where: { phone } });
      expect(finalCount).toBe(1);
    });

    it('matches phone number variations (e.g. without +91 prefix) and rejects registration', async () => {
      const phone = makeUniquePhone(); // +91XXXXXXXXXX
      const rawDigits = phone.replace('+91', ''); // XXXXXXXXXX
      const existing = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
      });
      const wallet = await walletRepo.findOneByOrFail({
        userId: existing.user.id,
      });
      tracked.push({
        userId: existing.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Calling sendMsg91Otp with raw digits and isRegistration: true
      await expect(
        authService.sendMsg91Otp(rawDigits, { isRegistration: true }),
      ).rejects.toThrow(PhoneAlreadyRegisteredError);
    });
  });

  describe('Scenario 10: Existing user OTP login continues working normally', () => {
    it('allows existing user to login when isRegistration is false or omitted', async () => {
      const phone = makeUniquePhone();
      const first = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
      });
      const wallet = await walletRepo.findOneByOrFail({
        userId: first.user.id,
      });
      tracked.push({
        userId: first.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Normal login without isRegistration flag
      const second = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        isRegistration: false,
      });

      expect(second.user.id).toBe(first.user.id);
      expect(second.accessToken).toBeTruthy();

      // Normal sendMsg91Otp without registration flag succeeds
      const sendRes = await authService.sendMsg91Otp(phone);
      expect(sendRes.success).toBe(true);
    });
  });

  describe('Scenario 11: Deleted user can register as a fresh account with the same phone', () => {
    it('creates fresh account when previous account is in DELETED status', async () => {
      const phone = makeUniquePhone();
      const first = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
      });
      const wallet1 = await walletRepo.findOneByOrFail({
        userId: first.user.id,
      });
      tracked.push({
        userId: first.user.id,
        walletId: wallet1.id,
        balanceId: 'pending',
        phone,
      });

      // Mark first user as DELETED
      await userRepo.update(first.user.id, { status: UserStatus.DELETED });

      // Register new user with the same phone
      const second = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        isRegistration: true,
      });

      expect(second.user.id).not.toBe(first.user.id);
      expect(second.user.status).toBe(UserStatus.ACTIVE);

      const wallet2 = await walletRepo.findOneByOrFail({
        userId: second.user.id,
      });
      tracked.push({
        userId: second.user.id,
        walletId: wallet2.id,
        balanceId: 'pending',
        phone,
      });

      // Both user rows exist in DB, one DELETED and one ACTIVE
      const allForPhone = await userRepo.find({ where: { phone } });
      expect(allForPhone.length).toBe(2);
    });
  });

  describe('Scenario 12: Deletion-pending user follows existing restricted flow', () => {
    it('rejects registration with 409 but allows login with deletionPending: true', async () => {
      const phone = makeUniquePhone();
      const user = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
      });
      const wallet = await walletRepo.findOneByOrFail({
        userId: user.user.id,
      });
      tracked.push({
        userId: user.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Set user to DELETION_REQUESTED
      await userRepo.update(user.user.id, {
        status: UserStatus.DELETION_REQUESTED,
      });

      // Registration is blocked with 409
      await expect(
        authService.loginOrRegisterWithVerifiedIdentity({
          phone,
          verified: true,
          isRegistration: true,
        }),
      ).rejects.toThrow(PhoneAlreadyRegisteredError);

      // Normal login returns deletionPending: true
      const loginRes = await authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        isRegistration: false,
      });

      expect(loginRes.deletionPending).toBe(true);
      expect(loginRes.accessToken).toBeTruthy();
    });
  });

  describe('Scenario 13: Concurrent registration requests do not create duplicates', () => {
    it('handles concurrent registration race condition safely', async () => {
      const phone = makeUniquePhone();

      // Launch two concurrent registrations
      const results = await Promise.allSettled([
        authService.loginOrRegisterWithVerifiedIdentity({
          phone,
          verified: true,
          isRegistration: true,
        }),
        authService.loginOrRegisterWithVerifiedIdentity({
          phone,
          verified: true,
          isRegistration: true,
        }),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ user: { id: string } }> =>
          r.status === 'fulfilled',
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      // Exactly one must succeed and one must fail with PhoneAlreadyRegisteredError
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].reason).toBeInstanceOf(PhoneAlreadyRegisteredError);

      const wallet = await walletRepo.findOneByOrFail({
        userId: fulfilled[0].value.user.id,
      });
      tracked.push({
        userId: fulfilled[0].value.user.id,
        walletId: wallet.id,
        balanceId: 'pending',
        phone,
      });

      // Exactly 1 user exists in DB
      const count = await userRepo.count({ where: { phone } });
      expect(count).toBe(1);
    });
  });
});
