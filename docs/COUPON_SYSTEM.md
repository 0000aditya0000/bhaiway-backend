# BhaiWay Coupon Catalog System

Backend-only production coupon engine. Distinct from Assured `user_coupons` (`NEXT_ASSURED_DEPOSIT_FREE`), which remains unchanged.

## Approved v1 business rules (do not change without product approval)

1. **One code per booking** — a booking applies at most one catalog coupon code.
2. **Charge scope is explicit** — a coupon applies only to the configured / requested charge (`RIDE_FARE` or `ASSURED_SECURITY_DEPOSIT`). It is never silently applied twice to both fare and security deposit in one booking.
3. **No restore after redemption** — cancelling a booking does not restore capacity or reverse benefits for already-`REDEEMED` redemptions. Only `RESERVED` rows are released.
4. **Automatic trip-completion issuance stays inactive** — infrastructure exists; no rules are active by default; completing a trip does not issue coupons until product defines and activates rules.

## Architecture audit (integration points)

| Area | Authoritative location | Coupon integration |
| --- | --- | --- |
| Assured security fee | `calculateRiderAssuredDeposit` + `PassengerAssuredDepositPenaltyService.getDepositQuote` in `BookingsService.createAssuredDepositBooking` | Catalog discount applied **after** free-deposit voucher, **before** `createHoldInTransaction` |
| Assured free deposit voucher | `UserCoupon` / `lockUnusedDepositCoupon` | Unchanged; conflicts with catalog deposit coupons |
| Fare debit (Regular PAY_NOW, Commute, Assured PAY_NOW) | `BookingsService` debit paths | Optional `couponCode` reduces payable fare before debit |
| Wallet promotional credit | `WalletService.creditPointsInTransaction` + `WalletPointSource.PROMOTIONAL` | `POINTS_CREDIT` finalize |
| Trip completion | `RidesService.complete` | `CouponIssuanceService.onTripCompletedInTransaction` (no-op without active rules) |
| Admin auth | `JwtAuthGuard` + `AdminPermissionGuard` | Permission `ADMIN_COUPONS_MANAGE` |

## Benefit types

- `POINTS_CREDIT` — credits promotional/non-withdrawable balance (never driver earnings).
- `FIXED_DISCOUNT` — fixed points off eligible charge.
- `PERCENTAGE_DISCOUNT` — percent off, optional `maxDiscountAmount` cap.

One benefit type per coupon. Points credit is never treated as a fee discount.

## Ride types & charge scopes

- Ride: `ALL` | `REGULAR` | `ASSURED` | `OFFICE_COMMUTE` (maps from domain `COMMUTE`).
- Charge: `RIDE_FARE` | `ASSURED_SECURITY_DEPOSIT` | `BOTH`.
- Apply-time must pick a concrete charge (`RIDE_FARE` or `ASSURED_SECURITY_DEPOSIT`), not `BOTH`.

## Audience

- `PUBLIC` — visible to authenticated users when active/valid.
- `USER_SPECIFIC` — only assigned users may view/redeem.

## Redemption lifecycle

`RESERVED` → `REDEEMED` | `RELEASED` | `FAILED`

- Preview/validate do **not** consume capacity.
- Reserve under row lock + `reserved_count` / `redeemed_count` against limits.
- Finalize after successful hold/debit in the same DB transaction.
- Release reserved rows on cancellation (does not unwind already-`REDEEMED` outcomes).
- Config snapshot frozen on each redemption.

### Limit semantics

- `totalRedemptionLimit = 1` → global single-use.
- `perUserRedemptionLimit = 1` → single-use per user.
- `null` limits → unlimited (subject to the other dimension).

## Assured security-fee discount

1. `original = calculateRiderAssuredDeposit(seats, pricePerSeat, effectivePercentage)`.
2. If `NEXT_ASSURED_DEPOSIT_FREE` voucher applies → fee `0` (catalog deposit coupon rejected).
3. Else if catalog coupon for `ASSURED_SECURITY_DEPOSIT` → `discount = f(original)`, `final = max(0, original - discount)`.
4. Hold/charge **only** `final`.
5. Persist `original_assured_deposit_amount`, `coupon_discount_amount`, `assured_deposit_amount` (final), `coupon_redemption_id`.
6. Release/refund paths continue to use the held/collected amount only.

## Automatic issuance

- Tables: `coupon_issuance_rules` (`is_active` default **false**), `coupon_issuances`.
- Hook: trip completion → `CouponIssuanceService`.
- **No rules are activated in this delivery.** No coupons are issued for completed trips.
- Future: insert/activate a rule row + implement evaluator; use source `AUTOMATIC_TRIP_COMPLETION` with idempotency keys per trip/rule/user.

## APIs

### User (`JwtAuthGuard`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/coupons/public` | Public catalog |
| GET | `/coupons/mine` | Assigned private coupons |
| GET | `/coupons/:id` | Detail if visible |
| POST | `/coupons/validate` | No capacity consume |
| POST | `/coupons/preview` | Benefit math preview |
| GET | `/coupons/redemptions` | History |
| GET | `/coupons/issuances` | Issued-coupon history |

### Admin (`ADMIN_COUPONS_MANAGE`)

| Method | Path |
| --- | --- |
| POST | `/admin/coupons` |
| GET | `/admin/coupons` |
| GET | `/admin/coupons/:id` |
| POST | `/admin/coupons/:id/assignments` |
| PATCH | `/admin/coupons/:id/status` |

### Booking apply

`POST /bookings` body may include:

```json
{
  "rideId": "...",
  "seats": 1,
  "paymentMethod": "ASSURED_DEPOSIT",
  "farePayment": "PAY_LATER",
  "couponCode": "SAVE50",
  "couponChargeScope": "ASSURED_SECURITY_DEPOSIT"
}
```

## Error codes

`COUPON_NOT_FOUND`, `COUPON_INACTIVE`, `COUPON_EXPIRED`, `COUPON_NOT_STARTED`, `COUPON_INELIGIBLE`, `COUPON_EXHAUSTED`, `COUPON_ALREADY_USED`, `COUPON_NOT_ASSIGNED`, `COUPON_INVALID_CONFIG`, `COUPON_CODE_CONFLICT`.

## Migration

`1786589000000-CouponCatalogSystem.ts` — coupons, assignments, redemptions, issuance rules/records, audit logs, booking coupon columns.
