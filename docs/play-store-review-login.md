# Google Play Store review login

## Purpose

Allow Google Play Store reviewers to authenticate into the **production** BhaiWay app using a dedicated review phone + fixed OTP **without depending on MSG91 SMS delivery**.

This is an **authentication convenience only**. After login, the review user is a normal JWT subject and is subject to every production business rule (KYC, vehicle RC, wallet, payouts, women-only rides, etc.).

## Environment variables

```bash
PLAY_REVIEW_LOGIN_ENABLED=false   # must default to false
PLAY_REVIEW_PHONE=<configured review phone>
PLAY_REVIEW_OTP=<configured review OTP>
```

Render (production) example — set values in the dashboard, never commit real secrets:

```bash
PLAY_REVIEW_LOGIN_ENABLED=true
PLAY_REVIEW_PHONE=<configured review phone>
PLAY_REVIEW_OTP=<configured review OTP>
```

## How it works

Existing auth is MSG91 Widget based:

1. Mobile uses MSG91 Widget to send/verify OTP with MSG91.
2. Mobile sends `POST /auth/msg91/verify` with `{ "accessToken": "..." }`.
3. Backend verifies the token with MSG91 and issues a BhaiWay JWT.

Play review path (env-gated) extends the **same** verify endpoint:

```http
POST /auth/msg91/verify
Content-Type: application/json

{
  "phone": "<configured review phone>",
  "otp": "<configured review OTP>"
}
```

Required conditions (**all** must be true):

1. `PLAY_REVIEW_LOGIN_ENABLED === true`
2. submitted phone equals `PLAY_REVIEW_PHONE` (after existing `normalizePhone`)
3. submitted OTP equals `PLAY_REVIEW_OTP`

On success, backend:

- bypasses MSG91
- finds or creates the dedicated user for the configured review phone (idempotent)
- creates wallet/balance if new (same path as normal signup)
- returns the **same** `{ accessToken, user }` response as MSG91 verify

Optional send acknowledgement (no SMS, never returns OTP):

```http
POST /auth/msg91/send
{ "phone": "<configured review phone>" }
```

## Security restrictions

- Disabled by default (`PLAY_REVIEW_LOGIN_ENABLED=false`).
- OTP alone never authenticates.
- Wrong phone / wrong OTP / disabled feature → generic `401 Invalid credentials`.
- No special JWT claims (`isReviewUser`, bypass flags, etc.).
- Does **not** mark Aadhaar / DL / Vehicle RC as verified.
- Does **not** bypass wallet, payout, booking, or women-only rules.
- Credentials are never logged, never exposed via `/config`, never hard-coded in TypeScript.
- Simple in-process rate limiting applies to review credential attempts.

## Enable / disable

| Setting | Behavior |
|---------|----------|
| `PLAY_REVIEW_LOGIN_ENABLED=false` | Phone+OTP path always fails; MSG91 accessToken path unchanged |
| `PLAY_REVIEW_LOGIN_ENABLED=true` + matching phone/OTP | Review login succeeds |
| `PLAY_REVIEW_LOGIN_ENABLED=true` + mismatch | Auth failure |

## Mobile compatibility

- Preferred: mobile already uses MSG91 Widget for normal users.
- For Play review, the client may call `POST /auth/msg91/verify` with `phone` + `otp` when those fields are available, **or** continue using MSG91 Widget if MSG91 test numbers are configured separately.
- Response shape is identical to normal login — no mobile branching required for the JWT payload.
- If the mobile app currently **only** sends `accessToken` and cannot send `phone`/`otp`, a small mobile change (or MSG91 dashboard test number) is required for end-to-end Play review without SMS.

## Testing

```bash
npx jest --runInBand src/auth/auth.play-review-login.spec.ts
```

## Production checklist

- [ ] `PLAY_REVIEW_LOGIN_ENABLED=false` until Play review is active
- [ ] Set phone/OTP only in Render env (not git)
- [ ] Confirm review account can open the app without fabricated KYC
- [ ] Disable (`PLAY_REVIEW_LOGIN_ENABLED=false`) after review if desired
