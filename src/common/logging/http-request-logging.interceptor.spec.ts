import { Controller, Get, INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { HttpRequestLoggingInterceptor } from './http-request-logging.interceptor';

@Controller('http-log-probe')
class HttpLogProbeController {
  @Get()
  ok() {
    return { ok: true };
  }
}

@Module({
  controllers: [HttpLogProbeController],
})
class HttpLogProbeModule {}

describe('HttpRequestLoggingInterceptor', () => {
  let app: INestApplication;
  let logSpy: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [HttpLogProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new HttpRequestLoggingInterceptor());
    await app.init();

    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
  });

  afterAll(async () => {
    logSpy.mockRestore();
    await app.close();
  });

  it('adds X-Request-Id when missing and logs safe metadata only', async () => {
    const response = await request(app.getHttpServer())
      .get('/http-log-probe')
      .set('Authorization', 'Bearer SUPER_SECRET_JWT')
      .send({ accessToken: 'SHOULD_NEVER_BE_LOGGED', otp: '123456' })
      .expect(200);

    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-request-id'].length).toBeGreaterThan(0);

    const httpLogs = logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('req=') && line.includes('/http-log-probe'));

    expect(httpLogs.length).toBeGreaterThanOrEqual(1);
    const line = httpLogs[httpLogs.length - 1];
    expect(line).toMatch(/GET \/http-log-probe → 200 \d+ms user=anonymous/);
    expect(line).not.toContain('SUPER_SECRET_JWT');
    expect(line).not.toContain('Bearer');
    expect(line).not.toContain('SHOULD_NEVER_BE_LOGGED');
    expect(line).not.toContain('123456');
    expect(line).not.toContain('accessToken');
    expect(line).not.toContain('Authorization');
  });

  it('preserves an incoming X-Request-Id', async () => {
    const response = await request(app.getHttpServer())
      .get('/http-log-probe')
      .set('X-Request-Id', 'client-corr-abc-123')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('client-corr-abc-123');

    const httpLogs = logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('req=client-corr-abc-123'));

    expect(httpLogs.length).toBeGreaterThanOrEqual(1);
    expect(httpLogs[httpLogs.length - 1]).toContain(
      'req=client-corr-abc-123 GET /http-log-probe → 200',
    );
  });

  it('does not fail the request when logging throws', async () => {
    logSpy.mockImplementation(() => {
      throw new Error('logger boom');
    });

    await request(app.getHttpServer()).get('/http-log-probe').expect(200);
  });
});
