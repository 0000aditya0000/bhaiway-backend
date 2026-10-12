# Manual Withdrawals & Payment Methods

## Purpose

BhaiWay currently processes driver withdrawals **manually**. Drivers add a UPI or bank payment method, request a withdrawal from **Driver Earnings only**, and an admin completes the payout offline.

This is **not** RazorpayX. The withdrawal `provider` is `MANUAL` so a future `RAZORPAYX` processor can be added without changing wallet reservation logic.

## Payment methods

### Types

| Type | Fields |
| --- | --- |
| `UPI` | `upiId` |
| `BANK_ACCOUNT` | `accountHolderName`, encrypted `accountNumber`, `ifscCode`, `bankName` |

Bank account numbers are encrypted at rest (AES-256-GCM). APIs return `accountNumberMasked` only (e.g. `XXXX XXXX 4582`).

Payment methods belong to the authenticated JWT user. A user cannot access or withdraw with another user’s method.

### User APIs

| Method | Path |
| --- | --- |
| `POST` | `/wallet/payment-methods` |
| `GET` | `/wallet/payment-methods` |
| `GET` | `/wallet/payment-methods/:id` |
| `PATCH` | `/wallet/payment-methods/:id` |
| `DELETE` | `/wallet/payment-methods/:id` |

`DELETE`: hard-delete if never used by a withdrawal; otherwise `isActive = false`. Inactive methods are omitted from the list and cannot be selected for new withdrawals. Historical withdrawals keep their **snapshot**.

### Example create

```json
{ "type": "UPI", "upiId": "driver@upi" }
```

```json
{
  "type": "BANK_ACCOUNT",
  "accountHolderName": "Aditya Gangwar",
  "accountNumber": "123456789012",
  "ifscCode": "HDFC0001234",
  "bankName": "HDFC Bank"
}
```

## Withdrawal flow

```
User selects payment method + amount (Coins)
        ↓
POST /wallet/withdraw  (+ Idempotency-Key)
        ↓
Validate amount > 0 integer Coins
Validate payment method (owned + active)
Lock wallet balance (pessimistic)
Require sufficient driverEarnedAvailable
Create withdrawal INITIATED + payment method snapshot
Create WITHDRAWAL hold (DRIVER_EARNED only)
        ↓
Admin: INITIATED → PROCESSING  (hold stays reserved)
        ↓
Admin: PROCESSING → COMPLETED  (consume hold permanently)
```

Optional failure path:

`INITIATED|PROCESSING → FAILED|CANCELLED` → release hold once (restore available).

`COMPLETED` is terminal.

## Wallet reservation

| Event | Available Driver Earnings | Held |
| --- | --- | --- |
| Create withdrawal | ↓ amount | ↑ amount |
| PROCESSING | unchanged | unchanged |
| COMPLETED | unchanged (already held) | ↓ amount (consumed) |
| FAILED / CANCELLED | ↑ amount (released) | ↓ amount |

Uses existing `WalletService.createHold` / `releaseHold` / `consumeHold`.

**Purchased and promotional coins are never withdrawable.** Hold creation for `WITHDRAWAL` only allocates `DRIVER_EARNED` lots.

## Status lifecycle

Allowed transitions:

- `INITIATED` → `PROCESSING` | `FAILED` | `CANCELLED`
- `PROCESSING` → `COMPLETED` | `FAILED` | `CANCELLED`

Every admin transition writes `withdrawal_status_history` (previous, new, admin, remarks).

## User APIs

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/wallet/withdraw` | Requires `Idempotency-Key` |
| `GET` | `/wallet/withdrawals` | Paginated, newest first |
| `GET` | `/wallet/withdrawals/:id` | Own withdrawals only |

### Create request

```http
POST /wallet/withdraw
Authorization: Bearer <JWT>
Idempotency-Key: withdraw-<client-id>

{ "amount": 2000, "paymentMethodId": "<uuid>" }
```

### Create response (conceptual)

```json
{
  "id": "...",
  "referenceId": "WD-8F3K29A1",
  "amount": "2000",
  "status": "INITIATED",
  "paymentMethod": { "type": "UPI", "upiId": "driver@upi" },
  "createdAt": "...",
  "processedAt": null,
  "completedAt": null
}
```

Same user + same idempotency key returns the original withdrawal (no second hold).

## Admin APIs

Permission: `ADMIN_WITHDRAWALS_MANAGE`

| Method | Path |
| --- | --- |
| `GET` | `/admin/withdrawals` |
| `GET` | `/admin/withdrawals/:id` |
| `PATCH` | `/admin/withdrawals/:id/status` |

```json
{ "status": "PROCESSING", "remarks": "Bank transfer started" }
```

Admin cannot change amount, user, payment method, or hold size.

## Idempotency

- Withdrawal row: unique `(userId, idempotencyKey)`
- Hold: `withdrawal-hold:<key>`
- Consume: `withdrawal-consume:<withdrawalId>`
- Release: `withdrawal-release:<withdrawalId>:<status>`

## Notifications

| Status | Notification |
| --- | --- |
| INITIATED | Withdrawal request initiated |
| PROCESSING | Withdrawal being processed |
| COMPLETED | Withdrawal completed |

Uses the existing notification outbox / dispatcher.

## Security

Never trust from the client: `userId`, `walletId`, balances, status, hold IDs, admin remarks.

Insufficient withdrawable balance → `422 INSUFFICIENT_WITHDRAWABLE_BALANCE`.

## Future RazorpayX

Keep `provider = MANUAL`. Later add a processor interface (e.g. `RazorpayXWithdrawalProcessor`) without changing reservation / status semantics.
