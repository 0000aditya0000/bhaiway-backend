# Office Commute Driver Rewards (Backend)

Admin-configurable campaign milestones for Office Commute (`RideType.COMMUTE`) drivers. Prizes are fulfilment-tracked goods/vouchers up to a configured INR cap — **not** automatic wallet credits.

## Qualifying trip (authoritative)

A ride counts **once** for a campaign when all of:

1. `ride.rideType === COMMUTE`
2. `ride.status === COMPLETED` with `completedAt` set
3. At least **two distinct** passengers with:
   - `bookingMode === COMMUTE`
   - `status === COMPLETED`
   - `pickupStatus === PICKED_UP` (OTP/onboard verified pickup)
4. Not already recorded for `(campaign_id, ride_id)`

Booked-only or single-passenger rides do not count. Three passengers still count as **one trip**.

Hook: `RidesService.complete` → `CommuteRewardProgressService.recordQualifyingRideInTransaction` (same DB transaction, after booking status flip to COMPLETED).

## Month windows

Milestone windows are **N calendar months from `campaign.startsAt` in the campaign IANA timezone** (default `Asia/Kolkata`), not fixed 30-day blocks. Window end is exclusive.

## Lifecycle

- Campaign: `DRAFT` → `ACTIVE` ↔ `PAUSED` → `ENDED` → `ARCHIVED`
- Milestones editable only in `DRAFT` (active rules immutable)
- Claim: `UNDER_REVIEW` → `APPROVED` → `FULFILLED` (or `REJECTED`; reject may re-submit)
- DB: `UNIQUE (campaign_id, driver_id, milestone_id)` and `UNIQUE (campaign_id, ride_id)`
- Preceding milestone must be `APPROVED` or `FULFILLED` before a higher claim
- Overlapping ACTIVE campaigns: a qualifying ride can count toward each ACTIVE campaign whose `[startsAt, endsAt]` contains `completedAt`

## Admin APIs (`ADMIN_COMMUTE_REWARDS_MANAGE`)

| Method | Path | Notes |
|--------|------|--------|
| POST | `/admin/commute-rewards/campaigns` | Create DRAFT (+ optional milestones) |
| GET | `/admin/commute-rewards/campaigns` | List (paginated, optional status) |
| GET | `/admin/commute-rewards/campaigns/:id` | Detail + milestones |
| PATCH | `/admin/commute-rewards/campaigns/:id` | Update; schedule only in DRAFT |
| POST | `/admin/commute-rewards/campaigns/:id/milestones` | DRAFT only |
| PATCH | `/admin/commute-rewards/campaigns/:campaignId/milestones/:milestoneId` | DRAFT only |
| PATCH | `/admin/commute-rewards/campaigns/:id/status` | Activate / pause / resume / end / archive |
| GET | `/admin/commute-rewards/campaigns/:id/drivers` | Driver progress list |
| GET | `/admin/commute-rewards/campaigns/:id/audit` | Audit log |
| GET | `/admin/commute-rewards/claims` | Claims queue |
| POST | `/admin/commute-rewards/claims/:id/review` | `{ decision: APPROVE\|REJECT, reason? }` |
| POST | `/admin/commute-rewards/claims/:id/fulfil` | Mark prize delivered |

Banner / prize images: pass HTTPS (or storage) URLs only — reuse existing client upload; no new storage provider.

### Example create

```json
POST /admin/commute-rewards/campaigns
{
  "title": "Office Commute Driver Rewards 2026",
  "timezone": "Asia/Kolkata",
  "startsAt": "2026-01-01T00:00:00.000Z",
  "endsAt": "2027-01-01T00:00:00.000Z",
  "milestones": [
    { "sortOrder": 1, "title": "Level 1", "requiredTrips": 42, "windowMonths": 1, "prizeValueCapInr": 1000 },
    { "sortOrder": 2, "title": "Level 2", "requiredTrips": 250, "windowMonths": 6, "prizeValueCapInr": 5000 },
    { "sortOrder": 3, "title": "Level 3", "requiredTrips": 450, "windowMonths": 12, "prizeValueCapInr": 8000 }
  ]
}
```

## Driver APIs (JWT; identity from token)

| Method | Path |
|--------|------|
| GET | `/commute-rewards/campaigns` |
| GET | `/commute-rewards/campaigns/:id` |
| GET | `/commute-rewards/campaigns/:id/progress` |
| POST | `/commute-rewards/campaigns/:campaignId/milestones/:milestoneId/claims` |
| GET | `/commute-rewards/claims` |

### Example progress snippet

```json
{
  "driverId": "...",
  "campaignId": "...",
  "totalQualifyingTrips": 42,
  "campaignStatus": "ACTIVE",
  "campaignEndsAt": "...",
  "milestones": [
    {
      "milestoneId": "...",
      "sortOrder": 1,
      "requiredTrips": 42,
      "tripCountInWindow": 42,
      "remainingTrips": 0,
      "windowEndAt": "...",
      "thresholdMet": true,
      "precedingClaimed": true,
      "canClaim": true,
      "claimStatus": null,
      "prizeValueCapInr": 1000
    }
  ]
}
```

## Migration

`src/database/migrations/1786590000000-CommuteDriverRewards.ts`

Apply on non-production DBs only via the project's migration tooling.

## Evidence note

Passenger completion evidence is `BookingStatus.COMPLETED` + `BookingPickupStatus.PICKED_UP` after commute ride completion. There is no separate “fraud disqualified” flag on bookings today; cancelled/reversed bookings are simply not `COMPLETED`/`PICKED_UP` and therefore never qualify. If a future fraud pipeline marks completed rides invalid, add an explicit disqualification flag and exclude it in `recordQualifyingRideInTransaction`.
