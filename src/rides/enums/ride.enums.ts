export enum RideType {
  REGULAR = 'REGULAR',
  ASSURED = 'ASSURED',
}

export enum RideStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  /** Assured queue: waiting for visibility; not searchable or bookable. */
  ASSURANCE_PENDING = 'ASSURANCE_PENDING',
  /** Assured queue: visible offer; bookable until IN_PROGRESS. */
  ASSURANCE_ACTIVE = 'ASSURANCE_ACTIVE',
  IN_PROGRESS = 'IN_PROGRESS',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

/** Driver half-time choice for remaining seats on an Assured ride. */
export enum RegularSeatsPolicy {
  KEEP_ASSURED_ONLY = 'KEEP_ASSURED_ONLY',
  ALLOW_REGULAR_RIDERS = 'ALLOW_REGULAR_RIDERS',
}

export enum RideCancellationReason {
  DRIVER_CANCELLED = 'DRIVER_CANCELLED',
  DRIVER_NO_SHOW = 'DRIVER_NO_SHOW',
}
