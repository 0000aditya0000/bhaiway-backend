# Corporate Identity Verification

## Purpose

Corporate Identity Verification lets a logged-in BhaiWay user prove ownership of an **official company email address**.

It establishes only:

`corporate identity = VERIFIED`

It does **not** bypass Aadhaar, vehicle RC, driving license, driver approval, wallet, Women Only, booking, or ride publishing rules.

## Relationship to personal email verification

| Concern | Personal email verification | Corporate identity |
| --- | --- | --- |
| Endpoints | `POST/GET /users/email-verification/*` | `POST/GET /corporate-identity/*` |
| Stored on | `users.email` / `users.email_verified` | `corporate_identity_verifications` |
| Free email domains | Allowed (e.g. gmail.com) | Rejected |
| OTP purpose | `EMAIL_VERIFICATION` | `CORPORATE_IDENTITY` |
| OTP / SMTP stack | Shared | Shared |

Personal email verification behavior is unchanged. A corporate OTP cannot verify personal email, and a personal OTP cannot verify corporate identity.

## Business rules

1. The email must use an allowed corporate domain (not a blocked personal/free provider).
2. The user must complete OTP verification for that email.
3. Domain allow alone never marks a user corporate verified.

## Corporate email domain policy

Centralized in `CorporateEmailDomainPolicy`.

Initial blocked personal/free providers:

- gmail.com
- yahoo.com
- outlook.com
- hotmail.com
- live.com
- icloud.com
- proton.me
- protonmail.com
- zoho.com
- aol.com
- gmx.com
- yandex.com
- mail.com

Matching is DNS-label aware:

- `gmail.com` → blocked
- `mail.gmail.com` → blocked (subdomain)
- `evilgmail.com` → **not** blocked merely because the string ends with `gmail.com`

Add new free providers only in that policy class.

## Email normalization

Corporate emails are trimmed and lowercased before processing (same helper as personal email OTP).

Example: `" Employee@Company.COM "` → `employee@company.com`

`users.email` and `users.email_verified` are never modified by this feature.

## OTP flow

Reuses `EmailVerificationService` / SMTP:

- 4-digit cryptographically random OTP
- hashed storage (purpose included in HMAC material)
- 10-minute expiry
- 5 attempts
- 60-second resend cooldown
- 5 sends / hour
- previous active OTP invalidated on resend
- SMTP failure invalidates the unused OTP

Corporate rate limits are scoped to `userId + CORPORATE_IDENTITY` so changing the target email cannot bypass abuse controls.

Blocked personal domains reject with `CORPORATE_EMAIL_NOT_ALLOWED` **before** OTP generation, so they do not consume send limits.

### Email content

- From: existing SMTP sender (`BhaiWay <alerts@kodenzolabs.in>`)
- Subject: `Verify your BhaiWay corporate identity`

OTP plaintext is never returned by API responses and must not be logged.

## API endpoints

All require JWT. `userId` is taken from the token only.

### `POST /corporate-identity/send`

```json
{ "email": "employee@company.com" }
```

- Validates domain policy
- If same email already `VERIFIED`: returns `VERIFIED` without sending OTP (idempotent)
- Otherwise sends OTP and sets workflow to `OTP_PENDING`

### `POST /corporate-identity/verify`

```json
{ "email": "employee@company.com", "otp": "1234" }
```

On success:

```json
{
  "status": "VERIFIED",
  "email": "employee@company.com",
  "verifiedAt": "2026-10-12T10:00:00.000Z"
}
```

### `GET /corporate-identity/status`

| State | Response shape |
| --- | --- |
| Not verified | `{ "status": "NOT_VERIFIED", "email": null, "verifiedAt": null }` |
| OTP pending | `{ "status": "OTP_PENDING", "email": "<pending>", "verifiedAt": null }` |
| Verified | `{ "status": "VERIFIED", "email": "<corporate>", "verifiedAt": "..." }` |

## Statuses

- `NOT_VERIFIED`
- `OTP_PENDING`
- `VERIFIED`

One corporate identity row per user (`user_id` unique).

## Changing corporate email

Example: verified `employee@companyA.com`, then request `employee@companyB.com`:

1. Domain validation for B
2. OTP sent to B; previous corporate OTPs for the user are invalidated
3. Workflow status becomes `OTP_PENDING` for B
4. Authoritative verified email remains A until B’s OTP succeeds
5. On success, B becomes `VERIFIED` atomically
6. If B fails or expires, A remains the verified corporate identity

## Errors

| Code | HTTP | When |
| --- | --- | --- |
| `CORPORATE_EMAIL_NOT_ALLOWED` | 422 | Personal/free domain |
| Existing email OTP codes | 400/404/429/502 | Invalid/expired/rate-limited/SMTP |

Do not expose the blocklist or internal policy details to clients.

## Security

- JWT required; no `userId` in request body
- OTP lookup always includes authenticated `userId` + purpose + email
- User isolation: A cannot verify or read B’s corporate identity
- No plaintext OTP storage
- No automatic business-rule bypasses
