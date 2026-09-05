import { Gender } from './entities/user-profile.entity';

/**
 * Maps Aadhaar / KYC provider gender strings to the canonical Gender enum.
 * Returns null when the value cannot be mapped.
 */
export function mapVerifiedGenderToEnum(
  raw: string | null | undefined,
): Gender | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const normalized = raw.trim().toUpperCase();
  if (
    normalized === 'F' ||
    normalized === 'FEMALE' ||
    normalized === Gender.FEMALE
  ) {
    return Gender.FEMALE;
  }
  if (
    normalized === 'M' ||
    normalized === 'MALE' ||
    normalized === Gender.MALE
  ) {
    return Gender.MALE;
  }
  if (
    normalized === 'O' ||
    normalized === 'OTHER' ||
    normalized === 'TRANSGENDER' ||
    normalized === Gender.OTHER
  ) {
    return Gender.OTHER;
  }

  return null;
}
