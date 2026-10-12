# Ride publishing rules

## 1. Departure must be in the future

For **every** ride type (`REGULAR`, `ASSURED`, `COMMUTE`) and preferences such as women-only:

`departureDate` + `departureTime` (civil Asia/Kolkata) must be **strictly after** server `now`.

| Boundary | Result |
| --- | --- |
| departure &lt; now | Reject `RIDE_DEPARTURE_IN_PAST` (422) |
| departure = now | Reject `RIDE_DEPARTURE_IN_PAST` (422) |
| departure &gt; now | Allow |

Timezone: **`Asia/Kolkata`** via `civilDateTimeToDate` / `isAtOrAfterDeparture`.  
Do not trust client clocks. Do not use the Node process timezone.

Applied in:

- `RidesService.create` (all types)
- `RidesService.applyUnrestrictedRideFields` when departure date/time is updated

Message: `"Ride departure time must be in the future."`

## 2. One active Assured Ride per driver

A driver may have **at most one** Assured ride that is still active.

### Active (blocks another Assured publish)

- `ASSURANCE_PENDING`
- `ASSURANCE_ACTIVE`
- `IN_PROGRESS`

### Terminal (does not block)

- `COMPLETED`
- `CANCELLED`

Unused for Assured publish lifecycle: `DRAFT`, `PUBLISHED`.

Regular and Commute rides are **not** limited by this rule.

Different routes/dates do **not** bypass the rule.

Error: `ACTIVE_ASSURED_RIDE_EXISTS` (409)  
Message: `"You already have an active Assured Ride. Complete or cancel it before publishing another Assured Ride."`

## 3. Concurrency protection

1. Application check inside the Assured publish transaction (after `pg_advisory_xact_lock` per driver).
2. PostgreSQL partial unique index:

```sql
UQ_rides_one_active_assured_per_driver
ON rides (driver_id)
WHERE ride_type = 'ASSURED'
  AND status IN ('ASSURANCE_PENDING', 'ASSURANCE_ACTIVE', 'IN_PROGRESS')
```

## 4. Migration

`OneActiveAssuredRidePerDriver1786588000000`

Aborts if duplicate active Assured rides already exist (no automatic deletion).
