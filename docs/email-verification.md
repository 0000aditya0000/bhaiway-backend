# Email verification

BhaiWay sends a 4-digit OTP from our own mailbox with Nodemailer. No third-party email API is used.

## Environment variables

```
SMTP_HOST=mail.kodenzolabs.in
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=alerts@kodenzolabs.in
SMTP_PASSWORD=
SMTP_FROM_EMAIL=alerts@kodenzolabs.in
SMTP_FROM_NAME=BhaiWay
```

`SMTP_PASSWORD` must be set only in the server environment. Never commit it. The hash pepper is `ENCRYPTION_KEY` (falls back to `JWT_ACCESS_SECRET`).

## Endpoints

All routes require a BhaiWay JWT.

### Send OTP

`POST /users/email-verification/send`

```json
{ "email": "user@example.com" }
```

The email must already be stored on the authenticated user (normalized trim + lowercase). A successful response never includes the OTP.

### Verify OTP

`POST /users/email-verification/verify`

```json
{ "otp": "4827" }
```

The user and email are taken from the JWT / account, not from the client.

### Status

`GET /users/email-verification/status`

```json
{ "email": "user@example.com", "verified": true }
```

## Rules

- OTP is exactly 4 digits (`crypto.randomInt(1000, 10000)`).
- Only a salted HMAC-SHA256 hash is stored.
- Expires after 10 minutes.
- Maximum 5 verification attempts per OTP.
- 60-second resend cooldown.
- Maximum 5 sends per email per rolling hour.
- A new OTP invalidates any previous active OTP.
- Successful verification is single-use and marks `users.email_verified = true`.

## SMTP

Host `mail.kodenzolabs.in`, port `465`, implicit TLS (`secure=true`), sender `BhaiWay <alerts@kodenzolabs.in>`.
