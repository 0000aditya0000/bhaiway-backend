import { NotificationType } from './enums/notification.enums';

export function bookingReceivedKey(bookingId: string): string {
  return `booking-received:${bookingId}`;
}

export function bookingConfirmedKey(bookingId: string): string {
  return `booking-confirmed:${bookingId}`;
}

export function bookingCancelledKey(
  bookingId: string,
  recipientUserId: string,
): string {
  return `booking-cancelled:${bookingId}:${recipientUserId}`;
}

export function commuteRequestedKey(bookingId: string): string {
  return `commute-requested:${bookingId}`;
}

export function commuteConfirmedKey(bookingId: string): string {
  return `commute-confirmed:${bookingId}`;
}

export function commuteCancelledKey(
  bookingId: string,
  recipientUserId: string,
): string {
  return `commute-cancelled:${bookingId}:${recipientUserId}`;
}

export function assuredPublishedKey(rideId: string): string {
  return `assured-published:${rideId}`;
}

export function walletCreditedKey(walletTransactionId: string): string {
  return `wallet-credited:${walletTransactionId}`;
}

export function withdrawalInitiatedKey(withdrawalId: string): string {
  return `withdrawal-initiated:${withdrawalId}`;
}

export function withdrawalProcessingKey(withdrawalId: string): string {
  return `withdrawal-processing:${withdrawalId}`;
}

export function withdrawalCompletedKey(withdrawalId: string): string {
  return `withdrawal-completed:${withdrawalId}`;
}

export function chatMessageKey(messageId: string): string {
  return `chat-message:${messageId}`;
}

export function noShowClaimOpenedKey(
  claimId: string,
  recipientUserId: string,
): string {
  return `no-show-opened:${claimId}:${recipientUserId}`;
}

export function adminRideCancelledKey(
  rideId: string,
  recipientUserId: string,
): string {
  return `admin-ops-cancel:${rideId}:${recipientUserId}`;
}

export function sosDriverAlertKey(sosId: string): string {
  return `sos-driver-alert:${sosId}`;
}

export function sosPassengerAlertKey(sosId: string, userId: string): string {
  return `sos-passenger-alert:${sosId}:${userId}`;
}

export function sosAdditionalTriggerKey(
  sosId: string,
  triggerId: string,
): string {
  return `sos-additional-trigger:${sosId}:${triggerId}`;
}

export function noShowClaimResolvedKey(
  claimId: string,
  recipientUserId: string,
  resolution: 'approved' | 'rejected' | 'timeout',
): string {
  return `no-show-${resolution}:${claimId}:${recipientUserId}`;
}

export function redactToken(token: string): string {
  if (token.length <= 12) {
    return '***';
  }
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function stringifyNotificationData(
  data: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) {
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

export function formatInrAmount(amount: string | number | bigint): string {
  const asString =
    typeof amount === 'bigint' ? amount.toString() : String(amount);
  const normalized = asString.includes('.')
    ? asString.replace(/\.?0+$/, '')
    : asString;
  return normalized;
}

export const NOTIFICATION_TYPE_LABEL: Record<NotificationType, string> = {
  [NotificationType.BOOKING_RECEIVED]: 'BOOKING_RECEIVED',
  [NotificationType.BOOKING_CONFIRMED]: 'BOOKING_CONFIRMED',
  [NotificationType.BOOKING_CANCELLED]: 'BOOKING_CANCELLED',
  [NotificationType.COMMUTE_BOOKING_REQUESTED]: 'COMMUTE_BOOKING_REQUESTED',
  [NotificationType.COMMUTE_BOOKING_CONFIRMED]: 'COMMUTE_BOOKING_CONFIRMED',
  [NotificationType.COMMUTE_BOOKING_CANCELLED]: 'COMMUTE_BOOKING_CANCELLED',
  [NotificationType.ASSURED_RIDE_PUBLISHED]: 'ASSURED_RIDE_PUBLISHED',
  [NotificationType.WALLET_CREDITED]: 'WALLET_CREDITED',
  [NotificationType.AADHAAR_VERIFICATION_REWARD]: 'AADHAAR_VERIFICATION_REWARD',
  [NotificationType.REFERRAL_REWARD_REFERRER]: 'REFERRAL_REWARD_REFERRER',
  [NotificationType.REFERRAL_REWARD_REFERRED]: 'REFERRAL_REWARD_REFERRED',
  [NotificationType.CHAT_MESSAGE]: 'CHAT_MESSAGE',
  [NotificationType.WITHDRAWAL_INITIATED]: 'WITHDRAWAL_INITIATED',
  [NotificationType.WITHDRAWAL_PROCESSING]: 'WITHDRAWAL_PROCESSING',
  [NotificationType.WITHDRAWAL_COMPLETED]: 'WITHDRAWAL_COMPLETED',
  [NotificationType.SUPPORT_TICKET_CREATED]: 'SUPPORT_TICKET_CREATED',
  [NotificationType.SUPPORT_TICKET_IN_PROGRESS]: 'SUPPORT_TICKET_IN_PROGRESS',
  [NotificationType.SUPPORT_TICKET_RESOLVED]: 'SUPPORT_TICKET_RESOLVED',
  [NotificationType.SUPPORT_TICKET_COMMENT]: 'SUPPORT_TICKET_COMMENT',
  [NotificationType.NO_SHOW_CLAIM_OPENED]: 'NO_SHOW_CLAIM_OPENED',
  [NotificationType.NO_SHOW_CLAIM_APPROVED]: 'NO_SHOW_CLAIM_APPROVED',
  [NotificationType.NO_SHOW_CLAIM_REJECTED]: 'NO_SHOW_CLAIM_REJECTED',
  [NotificationType.NO_SHOW_CLAIM_TIMEOUT]: 'NO_SHOW_CLAIM_TIMEOUT',
  [NotificationType.ADMIN_RIDE_CANCELLED]: 'ADMIN_RIDE_CANCELLED',
  [NotificationType.SOS_DRIVER_ALERT]: 'SOS_DRIVER_ALERT',
  [NotificationType.SOS_PASSENGER_ALERT]: 'SOS_PASSENGER_ALERT',
  [NotificationType.SOS_ADDITIONAL_TRIGGER]: 'SOS_ADDITIONAL_TRIGGER',
};
