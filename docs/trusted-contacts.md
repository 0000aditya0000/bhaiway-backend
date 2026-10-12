# Trusted Contacts (Safety Hub)

## Purpose

Authenticated BhaiWay users can maintain a private list of trusted contacts for future Safety Hub features (SOS, emergency alerts, trip sharing).

**This module only stores and manages contacts.** It does **not** send SMS, calls, push, WhatsApp, or email to contacts.

## Data model

Table: `trusted_contacts`

| Column | Notes |
| --- | --- |
| `id` | UUID PK |
| `user_id` | Owner BhaiWay user (FK → `users.id`, CASCADE) |
| `name` | 2–100 chars |
| `phone_number` | Normalized `+91XXXXXXXXXX` |
| `relationship` | Enum (see below) |
| `photo_url` | Optional text URL / storage reference |
| `created_at` / `updated_at` | Timestamps |
| `deleted_at` | Soft delete |

Constraints:

- Index on `user_id`
- Unique `(user_id, phone_number)` **where `deleted_at IS NULL`**

A trusted contact is **not** required to be a BhaiWay user. There is no `contactUserId`.

### Relationship enum

`PARENT` · `MOTHER` · `FATHER` · `BROTHER` · `SISTER` · `SPOUSE` · `PARTNER` · `FRIEND` · `RELATIVE` · `COLLEAGUE` · `OTHER`

## Ownership / security

- All routes require JWT (`JwtAuthGuard`).
- Owner id is always `currentUser.userId` from the token.
- Request body `userId` is rejected (`forbidNonWhitelisted`).
- Every read/update/delete filters by `{ id, userId }`.
- Missing or foreign contacts return `TRUSTED_CONTACT_NOT_FOUND` (404) — no leakage.

Trusted contacts are **not** exposed on public profile, rides, wallet, referrals, or admin list APIs.

## APIs

Base path: `/safety/trusted-contacts`

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/` | Create |
| `GET` | `/` | List (paginated, newest first) |
| `GET` | `/:id` | Get one |
| `PATCH` | `/:id` | Update |
| `DELETE` | `/:id` | Soft delete |

### Create

```json
{
  "name": "Rahul Gangwar",
  "phoneNumber": "+919876543210",
  "relationship": "BROTHER",
  "photoUrl": null
}
```

`photoUrl` is optional.

### List

`GET /safety/trusted-contacts?page=1&limit=20`

```json
{
  "items": [ /* TrustedContact */ ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

## Validation

| Field | Rules |
| --- | --- |
| Name | Required on create; trim; 2–100 chars |
| Phone | Required on create; India mobile → `+91` + 10 digits starting 6–9 |
| Relationship | Required enum |
| Photo | Optional string ≤ 2048 chars |

Phone examples accepted and normalized: `9876543210`, `919876543210`, `+91 98765 43210` → `+919876543210`.

## Maximum contacts

Env: `MAX_TRUSTED_CONTACTS` (default **5**).

When exceeded: `TRUSTED_CONTACT_LIMIT_REACHED` (422) —  
“You can add up to 5 trusted contacts.”

Create uses a transaction + row lock on the user’s active contacts so concurrent creates cannot bypass the limit.

## Duplicates

Active contacts cannot share the same normalized phone for one user (`DUPLICATE_TRUSTED_CONTACT`, 409).

After soft delete, the same phone may be added again.

## Photo handling

There is **no** dedicated image upload/storage module in this backend yet (profile photos are also URL strings).

Trusted contacts store optional `photoUrl` the same way. Mobile may supply a supported URL/reference. Do not send storage credentials to clients.

## Delete behavior

Soft delete (`deleted_at`). Soft-deleted contacts disappear from list/get. Rows remain for future SOS historical references. Photo assets are not deleted by this API.

## Error codes

| Code | HTTP |
| --- | --- |
| `TRUSTED_CONTACT_NOT_FOUND` | 404 |
| `TRUSTED_CONTACT_LIMIT_REACHED` | 422 |
| `INVALID_TRUSTED_CONTACT_NAME` | 422 |
| `INVALID_TRUSTED_CONTACT_PHONE` | 422 |
| `INVALID_TRUSTED_CONTACT_RELATIONSHIP` | 422 (validation) |
| `DUPLICATE_TRUSTED_CONTACT` | 409 |

## Future SOS integration

Future emergency features should reference `TrustedContact.id` (and respect soft-delete / ownership). This module intentionally does not implement SOS, live location, SMS, or escalation.

## Migration

`TrustedContacts1786587000000`
