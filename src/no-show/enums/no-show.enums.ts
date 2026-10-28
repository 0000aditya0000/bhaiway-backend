export enum NoShowClaimKind {
  DRIVER_NO_SHOW = 'DRIVER_NO_SHOW',
  PASSENGER_NO_SHOW = 'PASSENGER_NO_SHOW',
}

export enum NoShowClaimStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUPERSEDED = 'SUPERSEDED',
}

export enum NoShowDecisionSource {
  RESPONDENT = 'RESPONDENT',
  TIMEOUT = 'TIMEOUT',
}

export enum NoShowClaimEffectKind {
  NOTIFY_RESOLVED = 'NOTIFY_RESOLVED',
  OPEN_SUPPORT = 'OPEN_SUPPORT',
}

export enum NoShowClaimEffectStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
