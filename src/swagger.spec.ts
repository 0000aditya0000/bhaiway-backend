import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from './app.module';
import { setupSwagger, SWAGGER_PATH } from './swagger';
import { assertSafeTestDatabaseUrl } from './wallet/test/wallet-test.helpers';

describe('Swagger (smoke)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('serves Swagger UI at /api/docs', async () => {
    const response = await request(app.getHttpServer())
      .get(`/${SWAGGER_PATH}`)
      .expect(200);

    expect(response.text).toContain('Swagger UI');
  });

  it('serves OpenAPI JSON with expected metadata and tags', async () => {
    const response = await request(app.getHttpServer())
      .get(`/${SWAGGER_PATH}-json`)
      .expect(200);

    expect(response.body.info.title).toBe('BhaiWay Backend API');
    expect(response.body.info.version).toBe('1.0');
    expect(response.body.components.securitySchemes.bearer).toBeDefined();

    const tags = (response.body.tags ?? []).map(
      (tag: { name: string }) => tag.name,
    );
    expect(tags).toEqual(
      expect.arrayContaining([
        'Auth',
        'Users',
        'Verification',
        'Vehicles',
        'Rides',
        'Bookings',
        'Wallet',
      ]),
    );

    expect(response.body.paths['/auth/msg91/verify']).toBeDefined();
    expect(response.body.paths['/users/me']).toBeDefined();
    expect(response.body.paths['/verification/me']).toBeDefined();
    expect(response.body.paths['/vehicles']).toBeDefined();
    expect(response.body.paths['/rides']).toBeDefined();
    expect(response.body.paths['/rides/my']).toBeDefined();
    expect(response.body.paths['/rides/search']).toBeDefined();
    expect(response.body.paths['/rides/public/{id}']).toBeDefined();
    expect(response.body.paths['/bookings']).toBeDefined();
    expect(response.body.paths['/bookings/my']).toBeDefined();
  });
});
