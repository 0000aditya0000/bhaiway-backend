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

export function chatMessageKey(messageId: string): string {
  return `chat-message:${messageId}`;
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
  [NotificationType.CHAT_MESSAGE]: 'CHAT_MESSAGE',
};
