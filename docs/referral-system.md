# BhaiWay Referral System

## Purpose

Existing users share a unique referral code. When a **new** user registers with a valid code, both the referrer and the referred user receive **50 promotional (non-withdrawable) BhaiWay Coins**, recorded in the existing wallet ledger.

This is backend-only. Mobile invite UI is out of scope for this feature.

## Referral code

| Property | Rule |
| --- | --- |
| Location | `users.referral_code` |
| Format | `BHW` + 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I/O/0/1) |
| Generation | Backend only (`generateReferralCode` / `allocateUniqueReferralCode`) |
| Uniqueness | Partial unique index `UQ_users_referral_code` |
| Mutability | Immutable for the user; no update API |
| Case | Stored uppercase; input normalized (trim + uppercase) |
| Blank input | Treated as omitted |

Lazy backfill: `GET /referrals/summary` calls `ensureUserReferralCode` for pre-migration users.

## Registration API

`POST /auth/msg91/verify` accepts optional `referralCode`:

```json
{
  "accessToken": "...",
  "referralCode": "BHW7K4P9"
}
```

Play Store review path also accepts it:

```json
{
  "phone": "...",
  "otp": "...",
  "referralCode": "BHW7K4P9"
}
```

Requests without `referralCode` behave exactly as before.

### When referral is applied

1. OTP / MSG91 identity is verified (existing flow).
2. If the phone already has a user → **login only**; referral code is **ignored**.
3. If creating a **new** user and a code is present:
   - Resolve referrer by normalized code (fail with `REFERRAL_CODE_INVALID` if unknown).
   - Create user + wallet + unique own referral code.
   - Create `referrals` row (`status = REWARDED`).
   - Credit 50 PROMOTIONAL coins to referred and referrer via `WalletService.creditPointsInTransaction`.
   - Enqueue referral notifications (idempotent).
4. Any failure rolls back the registration transaction (no partial user).

## Referral entity

Table: `referrals`

| Column | Notes |
| --- | --- |
| `id` | UUID PK |
| `referrer_user_id` | FK → users |
| `referred_user_id` | FK → users, **UNIQUE** (one referrer max) |
| `referral_code` | Snapshot of code used |
| `status` | `REWARDED` (simple transactional model) |
| `reward_coins` | `50` |
| `rewarded_at` | When credited |
| `created_at` / `updated_at` | Timestamps |

Indexes: referrer user id, referral code.

## Reward rules

| Party | Amount | Source | Transaction type | Withdrawable |
| --- | --- | --- | --- | --- |
| Referrer | 50 | `PROMOTIONAL` | `PROMOTIONAL_CREDIT` | No |
| Referred | 50 | `PROMOTIONAL` | `PROMOTIONAL_CREDIT` | No |

- Direct referral only (no multi-level).
- Independent of Aadhaar Verification Reward (both can apply).
- Ledger reference: `referenceType = REFERRAL`, `referenceId = referral.id`.

### Idempotency

| Credit | Key |
| --- | --- |
| Referrer | `referral-reward:referrer:{referralId}` |
| Referred | `referral-reward:referred:{referralId}` |

Notifications:

| Recipient | Key |
| --- | --- |
| Referrer | `referral-notify:referrer:{referralId}` |
| Referred | `referral-notify:referred:{referralId}` |

Duplicate registration / retries cannot double-credit (wallet idempotency + unique phone + unique `referred_user_id`).

## Wallet & withdrawal

Referral coins increase `promotionalAvailable` only. Withdrawals continue to use **DRIVER_EARNED** only. Referral rewards never become withdrawable and are not classified as driver earnings.

Transaction history titles: **Referral Reward** (via display mapper on `REFERRAL` / referral idempotency keys).

## APIs (authenticated)

### `GET /referrals/summary`

```json
{
  "referralCode": "BHW7K4P9",
  "totalReferrals": 5,
  "totalCoinsEarned": "250"
}
```

`totalCoinsEarned` is summed from referral records (`reward_coins`), not from current wallet balance.

### `GET /referrals?page=1&limit=20`

Newest first. Returns referred user’s id, display name, profile photo only — never phone, email, or Aadhaar.

```json
{
  "items": [
    {
      "id": "...",
      "referredUser": {
        "id": "...",
        "name": "Rahul",
        "profilePhoto": "..."
      },
      "rewardCoins": "50",
      "status": "REWARDED",
      "createdAt": "...",
      "rewardedAt": "..."
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

User id is taken from JWT only.

## Notifications

After successful commit of rewards:

- **Referrer:** “Your friend joined BhaiWay! 50 Coins have been added to your wallet. 🎉”
- **Referred:** “Welcome to BhaiWay! 50 Coins have been added to your wallet through your referral. 🎉”

Types: `REFERRAL_REWARD_REFERRER`, `REFERRAL_REWARD_REFERRED` (existing notifications outbox).

## Error codes

| Code | HTTP | When |
| --- | --- | --- |
| `REFERRAL_CODE_INVALID` | 422 | Code provided but not found |
| `SELF_REFERRAL_NOT_ALLOWED` | 422 | Referrer == referred |
| `REFERRAL_ALREADY_EXISTS` | 409 | Referred user already has a referral |
| `REFERRAL_CODE_GENERATION_FAILED` | 500 | Exhausted unique allocation retries |

Invalid codes abort **before** user creation.

## Security

- Codes are backend-generated and hard to guess (large alphabet space).
- Users cannot choose or edit codes.
- Self-referral blocked.
- List/summary scoped to authenticated user.
- No sensitive PII in referral list payloads.

## Migration

`1786586000000-ReferralSystem`

- `users.referral_code` + unique index
- `referrals` table
- notification enum values for referral rewards

## Concurrency

- Unique phone → one new user wins; loser reuses the winner (no second referral).
- Unique `referred_user_id` → one referral relationship.
- Wallet idempotency keys → exactly-once credits.
