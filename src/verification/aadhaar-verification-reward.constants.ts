/** One-time promotional reward for completing Aadhaar (DigiLocker) verification. */
export const AADHAAR_VERIFICATION_REWARD_COINS = 50n;

export const AADHAAR_VERIFICATION_REFERENCE_TYPE = 'AADHAAR_VERIFICATION';

export const AADHAAR_VERIFICATION_REWARD_IDEMPOTENCY_PREFIX =
  'aadhaar-verification-reward:';

export function aadhaarVerificationRewardIdempotencyKey(userId: string): string {
  return `${AADHAAR_VERIFICATION_REWARD_IDEMPOTENCY_PREFIX}${userId}`;
}

export function aadhaarVerificationRewardNotifyKey(userId: string): string {
  return `aadhaar-verification-reward-notify:${userId}`;
}
