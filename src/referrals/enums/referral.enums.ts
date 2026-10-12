export enum ReferralStatus {
  REWARDED = 'REWARDED',
}

export const REFERRAL_REWARD_COINS = 50n;
export const REFERRAL_REFERENCE_TYPE = 'REFERRAL';
export const REFERRAL_CODE_PREFIX = 'BHW';
export const REFERRAL_CODE_SUFFIX_LENGTH = 6;

/** Alphabet without ambiguous I/O/0/1 characters. */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function referralRewardReferrerIdempotencyKey(referralId: string): string {
  return `referral-reward:referrer:${referralId}`;
}

export function referralRewardReferredIdempotencyKey(referralId: string): string {
  return `referral-reward:referred:${referralId}`;
}

export function referralNotifyReferrerKey(referralId: string): string {
  return `referral-notify:referrer:${referralId}`;
}

export function referralNotifyReferredKey(referralId: string): string {
  return `referral-notify:referred:${referralId}`;
}
