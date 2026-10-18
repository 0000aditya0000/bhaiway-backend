export enum SupportTicketCategory {
  BOOKINGS_AND_RIDES = 'BOOKINGS_AND_RIDES',
  PAYMENTS_AND_WALLETS = 'PAYMENTS_AND_WALLETS',
  OTHERS = 'OTHERS',
}

export enum SupportTicketStatus {
  CREATED = 'CREATED',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
}

export enum SupportBookingsSubcategory {
  VEHICLE_ISSUE = 'VEHICLE_ISSUE',
  DRIVER_BEHAVIOUR = 'DRIVER_BEHAVIOUR',
  PAYMENT_FARE = 'PAYMENT_FARE',
  SAFETY_CONCERN = 'SAFETY_CONCERN',
  APP_ISSUES = 'APP_ISSUES',
  OTHER = 'OTHER',
}

export enum SupportPaymentsSubcategory {
  WALLET_ISSUE = 'WALLET_ISSUE',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  REFUND_ISSUE = 'REFUND_ISSUE',
  FARE_DISPUTE = 'FARE_DISPUTE',
  WITHDRAWAL_ISSUE = 'WITHDRAWAL_ISSUE',
  OTHER = 'OTHER',
}

export enum SupportOthersSubcategory {
  ACCOUNT_ISSUE = 'ACCOUNT_ISSUE',
  VERIFICATION_ISSUE = 'VERIFICATION_ISSUE',
  APP_ISSUE = 'APP_ISSUE',
  SUGGESTION = 'SUGGESTION',
  OTHER = 'OTHER',
}

export type SupportTicketSubcategory =
  | SupportBookingsSubcategory
  | SupportPaymentsSubcategory
  | SupportOthersSubcategory;

export enum SupportCommentAuthorType {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export enum SupportEligibleRidePeriod {
  ACTIVE = 'active',
  PAST = 'past',
}

export enum SupportRideRelationRole {
  DRIVER = 'DRIVER',
  PASSENGER = 'PASSENGER',
}

export const SUPPORT_CATEGORY_SUBCATEGORIES: Record<
  SupportTicketCategory,
  readonly string[]
> = {
  [SupportTicketCategory.BOOKINGS_AND_RIDES]: Object.values(
    SupportBookingsSubcategory,
  ),
  [SupportTicketCategory.PAYMENTS_AND_WALLETS]: Object.values(
    SupportPaymentsSubcategory,
  ),
  [SupportTicketCategory.OTHERS]: Object.values(SupportOthersSubcategory),
};

/** Allowed transitions. Reopening RESOLVED is intentionally unsupported. */
export const SUPPORT_STATUS_TRANSITIONS: Record<
  SupportTicketStatus,
  readonly SupportTicketStatus[]
> = {
  [SupportTicketStatus.CREATED]: [
    SupportTicketStatus.IN_PROGRESS,
    SupportTicketStatus.RESOLVED,
  ],
  [SupportTicketStatus.IN_PROGRESS]: [SupportTicketStatus.RESOLVED],
  [SupportTicketStatus.RESOLVED]: [],
};

export const SUPPORT_DESCRIPTION_MAX = 4000;
export const SUPPORT_COMMENT_MAX = 2000;
export const SUPPORT_SUBJECT_MAX = 200;
export const SUPPORT_ATTACHMENT_MAX = 3;
export const SUPPORT_ATTACHMENT_URL_MAX = 2048;

export const SUPPORT_ALLOWED_IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
] as const;

export const SUPPORT_ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
