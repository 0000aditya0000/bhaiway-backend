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

## 5. Daily Office Commute slot uniqueness (read-only production pre-check)

Partial unique indexes from `CommuteRideSeries1786599000000` are **COMMUTE-only**.
Run these **read-only** checks before applying the unique indexes on production.
They use the same predicate as each index. Do not migrate production from this workstream.

### Driver slot — `UQ_rides_commute_driver_slot`

Predicate: `ride_type = 'COMMUTE' AND status NOT IN ('CANCELLED', 'COMPLETED')`
Grouped by: `driver_id, departure_date, departure_time`

```sql
SELECT
  driver_id,
  departure_date,
  departure_time,
  COUNT(*) AS duplicate_count,
  array_agg(id ORDER BY created_at, id) AS ride_ids
FROM rides
WHERE ride_type = 'COMMUTE'
  AND status NOT IN ('CANCELLED', 'COMPLETED')
GROUP BY driver_id, departure_date, departure_time
HAVING COUNT(*) > 1;
```

### Vehicle slot — `UQ_rides_commute_vehicle_slot`

Predicate: `ride_type = 'COMMUTE' AND status NOT IN ('CANCELLED', 'COMPLETED')`
Grouped by: `vehicle_id, departure_date, departure_time`

```sql
SELECT
  vehicle_id,
  departure_date,
  departure_time,
  COUNT(*) AS duplicate_count,
  array_agg(id ORDER BY created_at, id) AS ride_ids
FROM rides
WHERE ride_type = 'COMMUTE'
  AND status NOT IN ('CANCELLED', 'COMPLETED')
GROUP BY vehicle_id, departure_date, departure_time
HAVING COUNT(*) > 1;
```

Empty result sets are required before `CREATE UNIQUE INDEX` on production.

## 6. Regular versus Commute same-slot race (investigated, not changed)

- `UQ_rides_commute_driver_slot` and `UQ_rides_commute_vehicle_slot` ignore Regular (and Assured) rows.
- Commute series publish takes `pg_advisory_xact_lock` on `commute-series:{driverId}` then `commute-vehicle:{vehicleId}`, then `assertSlotsAvailable` which **does** look at all non-terminal ride types.
- Regular `createRegularRide` does **not** take those locks and has **no** driver/vehicle datetime unique index.
- Therefore a Regular publish can race with a Commute series publish for the same driver or vehicle at the same civil datetime: both inserts can succeed because Regular is outside the unique indexes and outside the commute advisory locks.

**Product decision required before adding a cross-type unique index or Regular advisory locks.** Adding one would reject existing mixed Regular+Commute publishing at the same slot. Do not add that restriction until product confirms the intended rule and existing publish flows are checked.
