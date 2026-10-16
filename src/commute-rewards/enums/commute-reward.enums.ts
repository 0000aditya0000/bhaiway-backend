export enum CommuteRewardCampaignStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ENDED = 'ENDED',
  ARCHIVED = 'ARCHIVED',
}

/**
 * How a milestone's trip window is measured from campaign start.
 * Windows use calendar months in the campaign IANA timezone (not fixed 30-day blocks).
 */
export enum CommuteRewardWindowType {
  CALENDAR_MONTHS_FROM_START = 'CALENDAR_MONTHS_FROM_START',
}

export enum CommuteRewardClaimStatus {
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  FULFILLED = 'FULFILLED',
}

/** Claim statuses that permanently consume a milestone (cannot reclaim). */
export const COMMUTE_REWARD_CONSUMING_CLAIM_STATUSES: readonly CommuteRewardClaimStatus[] =
  [
    CommuteRewardClaimStatus.UNDER_REVIEW,
    CommuteRewardClaimStatus.APPROVED,
    CommuteRewardClaimStatus.FULFILLED,
  ];

/** Preceding milestone must reach one of these before a higher claim is allowed. */
export const COMMUTE_REWARD_SUCCESS_CLAIM_STATUSES: readonly CommuteRewardClaimStatus[] =
  [
    CommuteRewardClaimStatus.APPROVED,
    CommuteRewardClaimStatus.FULFILLED,
  ];
