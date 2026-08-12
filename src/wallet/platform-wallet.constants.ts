/** Fixed system identities for BhaiWay platform funds (not a normal user). */
export const PLATFORM_USER_ID = '00000000-0000-4000-8000-000000000001';
export const PLATFORM_WALLET_ID = '00000000-0000-4000-8000-000000000002';
/** Seeded platform account phone — must never authenticate. */
export const PLATFORM_PHONE = '+10000000000';

export const PLATFORM_USER_ID_SETTING_KEY = 'PLATFORM_USER_ID';
export const PLATFORM_WALLET_ID_SETTING_KEY = 'PLATFORM_WALLET_ID';

export const PLATFORM_SEED_LOT_ID = '00000000-0000-4000-8000-000000000004';
export const PLATFORM_SEED_LEDGER_ID = '00000000-0000-4000-8000-000000000005';
export const PLATFORM_SEED_IDEMPOTENCY_KEY = 'platform-seed:opening-float';
export const PLATFORM_SEED_AMOUNT = '10000000';

export function isPlatformUserId(userId: string): boolean {
  return userId === PLATFORM_USER_ID;
}

export function isPlatformWalletId(walletId: string): boolean {
  return walletId === PLATFORM_WALLET_ID;
}

export function isPlatformPhone(phone: string): boolean {
  return phone.replace(/\s+/g, '').trim() === PLATFORM_PHONE;
}
