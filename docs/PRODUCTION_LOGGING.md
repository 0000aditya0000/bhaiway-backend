# BhaiWay production logging & monitoring

## Architecture

| Component | Role |
| --- | --- |
| `StructuredNestLogger` (Pino) | One JSON object per log line to stdout/stderr |
| `HttpRequestLoggingInterceptor` | **Sole** HTTP completion event (method, route template, status, duration, requestId) |
| `AllExceptionsFilter` | Server-side 5xx diagnostics + stack (never in client body) |
| `AsyncLocalStorage` request context | Propagates `requestId` / `correlationId` |
| `AuditLogger` | Structured audit events (not a wallet ledger) |
| Optional Sentry | Opt-in via `SENTRY_DSN` |
| `/health/live` & `/health/ready` | Liveness / readiness |

Do **not** enable a second HTTP request logger (e.g. nestjs-pino middleware).

## Trace a request

1. Client receives `X-Request-Id` (and `X-Correlation-Id`) on every response.
2. Search PM2 logs: `pm2 logs bhaiway-api --lines 1000 | grep '<request-id>'`
3. Look for `event:"http.request.completed"` then optional `event:"http.exception.unhandled"` for 5xx.

## Environment

```bash
LOG_LEVEL=info                 # production default if unset
DB_SLOW_QUERY_MS=1000          # slow query warn threshold (params never logged)
SENTRY_DSN=                    # leave empty to disable
SENTRY_TRACES_SAMPLE_RATE=0
TYPEORM_LOGGING=               # only set `all` in local development
```

## Example sanitized logs

Success:

```json
{"level":"info","time":"2026-10-15T00:00:00.000Z","service":"bhaiway-api","environment":"production","event":"http.request.completed","requestId":"…","method":"POST","route":"/bookings","statusCode":201,"durationMs":42,"userId":"…","outcome":"success"}
```

Client error (warn, not error):

```json
{"level":"warn","event":"http.request.completed","method":"POST","route":"/auth/verify","statusCode":401,"outcome":"client_error","requestId":"…"}
```

## Sensitive fields

Redacted / never logged: passwords, OTPs, tokens, Authorization, cookies, API keys, webhook signatures, Aadhaar/KYC payloads, phone/email, UPI/bank, precise location, raw bodies.

## PM2

```bash
sudo mkdir -p /var/log/bhaiway
sudo chown <deploy-user>:<deploy-user> /var/log/bhaiway
pm2 start ecosystem.config.cjs
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 save
```

## Sentry (optional)

1. Create a Sentry project; copy DSN into VPS env only (`SENTRY_DSN`).
2. Restart PM2. Confirm `GET /health/ready` shows `"sentry":"configured"`.
3. Trigger a controlled 500 in staging; confirm event arrives with redacted headers and no body.
4. Unset `SENTRY_DSN` → app continues with local JSON logs only.

## Security note (malware removal)

During this upgrade the following were neutralized:

- `src/zzz_bootstrap.ts` — previously harvested host secrets into `/tmp/.bhx` and was imported from `main.ts`.
- `api.js` — previously obfuscated payload executed by `npm run build` / `npm start`.

`package.json` scripts no longer invoke `api.js`. Rotate all production secrets if those payloads ever ran on the VPS.
