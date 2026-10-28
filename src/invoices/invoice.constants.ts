import {
  ADMIN_PERMISSION_INVOICES_MANAGE,
  ADMIN_PERMISSION_INVOICES_VIEW,
} from '../admin/admin.constants';
import { RideType } from '../rides/enums/ride.enums';

export { ADMIN_PERMISSION_INVOICES_MANAGE, ADMIN_PERMISSION_INVOICES_VIEW };

export const INVOICE_ELIGIBLE_RIDE_TYPES: readonly RideType[] = [
  RideType.REGULAR,
  RideType.COMMUTE,
];

export const INVOICE_CURRENCY = 'INR';
export const INVOICE_PAISE_PER_RUPEE = 100n;
/** GST rate stored as basis points (1800 = 18.00%). */
export const INVOICE_RATE_BP_MIN = 1;
export const INVOICE_RATE_BP_MAX = 4000;
export const INVOICE_NUMBER_PAD = 6;
export const INVOICE_MAX_EMAIL_ATTEMPTS = 5;
export const INVOICE_MAX_JOB_ATTEMPTS = 8;
export const INVOICE_RETRY_BASE_MS = 5_000;
export const INVOICE_WORKER_POLL_MS = 15_000;
export const INVOICE_PREFIX_MAX = 16;
export const GSTIN_PATTERN =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const INDIAN_STATE_CODE_PATTERN = /^(0[1-9]|[1-3][0-9]|38)$/;
export const SAC_PATTERN = /^[0-9]{4,6}$/;

/** Singleton issuer-settings row. */
export const INVOICE_ISSUER_SETTINGS_ID =
  '00000000-0000-4000-8000-000000000021';

export const INVOICE_STORAGE_SUBDIR = 'invoices';
export const INVOICE_LOGO_MAX_BYTES = 1_048_576;
export const INVOICE_LOGO_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export function isEligibleInvoiceRideType(rideType: RideType): boolean {
  return INVOICE_ELIGIBLE_RIDE_TYPES.includes(rideType);
}

export function invoiceRideTypeLabel(rideType: RideType): string {
  if (rideType === RideType.COMMUTE) {
    return 'Daily Office Commute';
  }
  if (rideType === RideType.REGULAR) {
    return 'Outstation';
  }
  return rideType;
}
