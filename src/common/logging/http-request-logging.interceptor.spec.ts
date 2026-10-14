import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  INestApplication,
  Module,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { HttpRequestLoggingInterceptor } from './http-request-logging.interceptor';
import { resetMetricsForTests } from './metrics.registry';
import { getPinoLogger } from './structured-logger';

@Controller('http-log-probe')
class HttpLogProbeController {
  @Get()
  ok() {
    return { ok: true, secretShouldNotAppearInLogs: 'TOKEN' };
  }

  @Post('fail-client')
  failClient() {
    throw new HttpException(
      { statusCode: 400, code: 'BAD_INPUT', message: 'bad', otp: '999999' },
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('fail-server')
  failServer() {
    throw new Error('boom-internal');
  }
}

@Module({
  controllers: [HttpLogProbeController],
})
class HttpLogProbeModule {}

describe('HttpRequestLoggingInterceptor + AllExceptionsFilter', () => {
  let app: INestApplication;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

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
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const pino = getPinoLogger();
    infoSpy = jest.spyOn(pino, 'info').mockImplementation(() => pino);
    warnSpy = jest.spyOn(pino, 'warn').mockImplementation(() => pino);
    errorSpy = jest.spyOn(pino, 'error').mockImplementation(() => pino);
  });

  beforeEach(() => {
    infoSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
    resetMetricsForTests();
  });

  afterAll(async () => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    await app.close();
  });

  function completionEvents() {
    return [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => call[0])
      .filter(
        (payload) =>
          payload &&
          typeof payload === 'object' &&
          (payload as { event?: string }).event === 'http.request.completed',
      ) as Array<Record<string, unknown>>;
  }

  it('adds X-Request-Id, logs one structured completion, never dumps bodies/secrets', async () => {
    const response = await request(app.getHttpServer())
      .get('/http-log-probe')
      .set('Authorization', 'Bearer SUPER_SECRET_JWT')
      .set('Cookie', 'session=abc')
      .send({ accessToken: 'SHOULD_NEVER_BE_LOGGED', otp: '123456' })
      .expect(200);

    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f-]{36}$/i,
    );

    const completions = completionEvents();
    expect(completions.length).toBe(1);
    expect(completions[0]).toMatchObject({
      event: 'http.request.completed',
      method: 'GET',
      statusCode: 200,
      outcome: 'success',
    });
    expect(completions[0].route).toContain('/http-log-probe');

    const serialized = JSON.stringify(completions[0]);
    expect(serialized).not.toContain('SUPER_SECRET_JWT');
    expect(serialized).not.toContain('SHOULD_NEVER_BE_LOGGED');
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('accessToken');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('session=abc');
    expect(serialized).not.toContain('secretShouldNotAppearInLogs');
  });

  it('accepts valid client X-Request-Id and rejects unsafe ones', async () => {
    const good = await request(app.getHttpServer())
      .get('/http-log-probe')
      .set('X-Request-Id', 'client-corr-abc-123')
      .expect(200);
    expect(good.headers['x-request-id']).toBe('client-corr-abc-123');

    const bad = await request(app.getHttpServer())
      .get('/http-log-probe')
      .set('X-Request-Id', 'DROP TABLE; --')
      .expect(200);
    expect(bad.headers['x-request-id']).not.toBe('DROP TABLE; --');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('logs client errors at warn without treating them as server failures', async () => {
    const response = await request(app.getHttpServer())
      .post('/http-log-probe/fail-client')
      .expect(400);

    expect(response.body.code).toBe('BAD_INPUT');
    expect(response.headers['x-request-id']).toBeDefined();
    // Stack must not leak to client.
    expect(JSON.stringify(response.body)).not.toContain('stack');
    expect(JSON.stringify(response.body)).not.toContain('at ');

    const completions = completionEvents();
    expect(completions.length).toBe(1);
    expect(completions[0].statusCode).toBe(400);
    expect(completions[0].outcome).toBe('client_error');
    // No duplicate unhandled exception error for 4xx.
    const unhandled = errorSpy.mock.calls.filter(
      (c) =>
        c[0] &&
        typeof c[0] === 'object' &&
        (c[0] as { event?: string }).event === 'http.exception.unhandled',
    );
    expect(unhandled.length).toBe(0);
  });

  it('keeps stack traces server-side for 500s and returns safe body', async () => {
    const response = await request(app.getHttpServer())
      .get('/http-log-probe/fail-server')
      .expect(500);

    expect(response.body).toMatchObject({
      statusCode: 500,
      message: 'Internal server error',
    });
    expect(JSON.stringify(response.body)).not.toContain('boom-internal');
    expect(JSON.stringify(response.body)).not.toContain('stack');

    const unhandled = errorSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (p) =>
          p &&
          typeof p === 'object' &&
          (p as { event?: string }).event === 'http.exception.unhandled',
      ) as Array<Record<string, unknown>>;
    expect(unhandled.length).toBe(1);
    expect(unhandled[0].stack).toEqual(expect.any(String));
    expect(String(unhandled[0].stack)).toContain('boom-internal');
  });

  it('does not fail the request when logging throws', async () => {
    infoSpy.mockImplementation(() => {
      throw new Error('logger boom');
    });
    await request(app.getHttpServer()).get('/http-log-probe').expect(200);
  });
});
