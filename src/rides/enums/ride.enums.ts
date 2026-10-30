export enum RideType {
  REGULAR = 'REGULAR',
  ASSURED = 'ASSURED',
  /** Daily Office Commute: driver publishes base fare; riders see +10% markup. */
  COMMUTE = 'COMMUTE',
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
  ADMIN_CANCELLED = 'ADMIN_CANCELLED',
}

/** Direction of a series-generated Daily Office Commute occurrence. */
export enum RideDirection {
  OUTBOUND = 'OUTBOUND',
  RETURN = 'RETURN',
}

export enum RideSeriesStatus {
  ACTIVE = 'ACTIVE',
  CANCELLED = 'CANCELLED',
}

/** ISO-style weekday names. Used when excluding days from a 7-day commute window. */
export enum Weekday {
  MONDAY = 'MONDAY',
  TUESDAY = 'TUESDAY',
  WEDNESDAY = 'WEDNESDAY',
  THURSDAY = 'THURSDAY',
  FRIDAY = 'FRIDAY',
  SATURDAY = 'SATURDAY',
  SUNDAY = 'SUNDAY',
}

/** Scope for commute series update/cancel. Default is THIS_OCCURRENCE. */
export enum SeriesScope {
  THIS_OCCURRENCE = 'THIS_OCCURRENCE',
  THIS_AND_FUTURE = 'THIS_AND_FUTURE',
}
