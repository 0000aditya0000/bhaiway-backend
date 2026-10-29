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
/** Pending jobs processed synchronously when a rider lists invoices. */
export const INVOICE_LIST_PROCESS_LIMIT = 8;
export const INVOICE_RIDER_ENSURE_LIMIT = 50;
export const INVOICE_PREFIX_MAX = 16;
export const GSTIN_PATTERN =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const INDIAN_STATE_CODE_PATTERN = /^(0[1-9]|[1-3][0-9]|38)$/;
export const SAC_PATTERN = /^[0-9]{4,6}$/;

/** Singleton issuer-settings row. */
export const INVOICE_ISSUER_SETTINGS_ID =
  '00000000-0000-4000-8000-000000000021';
/** Stored on gst_invoices.tax_config_id when no active GST tax rule exists. */
export const INVOICE_UNCONFIGURED_TAX_CONFIG_ID =
  '00000000-0000-4000-8000-000000000022';
export const INVOICE_FALLBACK_SAC = '996411';
export const INVOICE_FALLBACK_SERVICE_CATEGORY = 'Passenger transportation';
export const INVOICE_FALLBACK_TAX_NOTES =
  'Issued without an active GST tax rule. GST was not applied. Amount equals the completed booking fare.';

export const INVOICE_STORAGE_SUBDIR = 'invoices';
export const INVOICE_LOGO_MAX_BYTES = 1_048_576;
export const INVOICE_LOGO_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type InvoiceLogoMime = (typeof INVOICE_LOGO_MIME)[number];

/** Identify a logo from file bytes so proxy/multer mimetype loss does not 500. */
export function detectInvoiceLogoMime(
  buffer: Buffer,
  declared?: string | null,
): InvoiceLogoMime | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  const normalized = declared === 'image/jpg' ? 'image/jpeg' : declared;
  if (normalized && (INVOICE_LOGO_MIME as readonly string[]).includes(normalized)) {
    return normalized as InvoiceLogoMime;
  }
  return null;
}

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
