# Admin Dashboard (backend)

Operations command-center APIs for the BhaiWay Admin Dashboard.

## Authorization

### Login

`POST /admin/auth/login`

```json
{ "username": "lucifer", "password": "***" }
```

Response:

```json
{
  "accessToken": "<jwt>",
  "admin": {
    "id": "...",
    "username": "lucifer",
    "permissions": ["ADMIN_DASHBOARD_VIEW"]
  }
}
```

Credentials are configured via environment variables:

```
ADMIN_USERNAME=lucifer
ADMIN_PASSWORD=
```

The password is hashed with scrypt and stored on `admin_users.password_hash`. It is never returned in API responses or logged.

On startup, when `ADMIN_PASSWORD` is set, the backend bootstraps/updates the `lucifer` admin account with `ADMIN_DASHBOARD_VIEW`.

### Protected routes

All dashboard routes require:

1. Valid BhaiWay JWT from admin login (`Authorization: Bearer …`)
2. Active row in `admin_users` for that user
3. Permission `ADMIN_DASHBOARD_VIEW`

## Endpoints

### `GET /admin/dashboard/summary`

Operational-day metrics for **Asia/Kolkata**.

```json
{
  "period": {
    "timezone": "Asia/Kolkata",
    "start": "2026-03-20T18:30:00.000Z",
    "end": "2026-03-21T18:30:00.000Z"
  },
  "metrics": {
    "revenueToday": 1250,
    "totalRidesToday": 40,
    "activeRidesNow": 5,
    "cancelledRidesToday": 2,
    "completedRidesToday": 30,
    "users": 1000,
    "drivers": 120,
    "assuredRidesToday": 8
  },
  "attention": {
    "critical": 1,
    "warning": 2,
    "total": 3,
    "alerts": []
  },
  "recentActivity": []
}
```

### `GET /admin/dashboard/live-map?filter=ACTIVE|OFFICE_COMMUTE|OUTSTATION|SOS`

Uses existing Redis ride tracking keys (`ride:tracking:{rideId}`).

| Filter | Behavior |
| --- | --- |
| `ACTIVE` | All `IN_PROGRESS` rides |
| `OFFICE_COMMUTE` | `IN_PROGRESS` + `rideType=COMMUTE` |
| `OUTSTATION` | `IN_PROGRESS` + `REGULAR` or `ASSURED` (no `OUTSTATION` enum exists) |
| `SOS` | Empty list — SOS is not implemented in the ride model |

### `GET /admin/dashboard/recent-activity?limit=20&cursor=`

Cursor pagination by `createdAt` (newest first).

## Metric definitions

| Metric | Definition |
| --- | --- |
| `totalRidesToday` | `rides.created_at` in IST day |
| `activeRidesNow` | `status = IN_PROGRESS` |
| `cancelledRidesToday` | `status = CANCELLED` and `cancelled_at` in IST day |
| `completedRidesToday` | `status = COMPLETED` and `completed_at` in IST day |
| `assuredRidesToday` | `ride_type = ASSURED` and `created_at` in IST day |
| `users` | `users` count excluding platform system user |
| `drivers` | Users with current `IDENTITY` + `VEHICLE` verifications `VERIFIED` (same rule as `canPublishRide`) |

## Revenue

`revenueToday` is **platform revenue**, not gross fare.

Sum of `POSTED` credits on `PLATFORM_WALLET_ID` with types:

- `COMMUTE_PLATFORM_MARGIN`
- `ASSURED_PLATFORM_FORFEITURE`
- `ASSURED_PASSENGER_CANCEL_FARE_PLATFORM`

Excluded: `PLATFORM_SEED`, `BOOKING_PAYMENT`, `DRIVER_EARNING`, `POINT_PURCHASE`, refunds, holds, deposits.

## Alerts / health

Tables: `admin_alerts`, `admin_activity_events`.

Cashfree Vehicle RC upstream failures (network / 5xx) open a deduplicated incident:

- title: `RC Verification unavailable`
- recovery activity: `RC Verification recovered`

Dashboard summary does **not** probe third-party APIs.

## Quick actions

Create Coupon / Send Notification / Support are navigation-only on the frontend. No dashboard-specific duplicate APIs.

## Migration

`1786580000000-AdminDashboardFoundation` — admin tables + `rides.completed_at`  
`1786581000000-AdminLoginCredentials` — `admin_users.username` / `password_hash`
