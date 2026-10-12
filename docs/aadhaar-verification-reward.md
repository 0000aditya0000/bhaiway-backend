# Aadhaar Verification Reward (50 BhaiWay Coins)

## Eligibility

Every BhaiWay user is eligible for a **one-time** reward of **50 BhaiWay Coins** after successfully completing **Aadhaar verification** via DigiLocker (Cashfree).

Registration alone does **not** credit the reward.

## Trigger

Backend-authoritative path only:

`CashfreeKycService.completeAadhaarVerification`

Used by:

- DigiLocker status refresh (`POST /kyc/aadhaar/digilocker/refresh`) when Cashfree reports `AUTHENTICATED` and Aadhaar document is fetched
- Cashfree DigiLocker webhooks that finalize document verification

Mobile never credits the reward.

## Ledger classification

| Field | Value |
| --- | --- |
| Source | `PROMOTIONAL` |
| Transaction type | `PROMOTIONAL_CREDIT` |
| Amount | `50` |
| Reference type | `AADHAAR_VERIFICATION` |
| Idempotency key | `aadhaar-verification-reward:{userId}` |

Uses `WalletService.creditPointsInTransaction` inside the same DB transaction that marks identity `VERIFIED`.

## Non-withdrawable

`PROMOTIONAL` lots are never eligible for withdrawal holds.

Withdrawable balance continues to use **Driver Earnings (`DRIVER_EARNED`) only**.

Example:

- Driver Earnings = 500, Reward = 50 → total 550, withdrawable **500**

## Spending

Reward coins follow existing spend priority:

`PROMOTIONAL` → `PURCHASED` → `DRIVER_EARNED`

## Idempotency

Webhook retries, repeated refresh, and already-`VERIFIED` recovery paths call the same credit.

Exactly one ledger row per user. Replays return the existing transaction.

## Failure / non-success states

No reward for:

`PENDING`, `INITIATED`, `AUTHENTICATED` (incomplete), `FAILED`, `EXPIRED`, `CONSENT_DENIED`, `CONSENT_EXPIRED`

## Existing users

No blanket migration. Reward is credited when a successful Aadhaar completion is processed after deploy (or recovered on already-verified refresh via the same idempotent key).

## Transaction history

Display title: **Aadhaar Verification Reward**  
Category: **BONUS**

## Notification

`AADHAAR_VERIFICATION_REWARD`:

> 50 BhaiWay Coins have been added to your wallet for completing Aadhaar verification.
