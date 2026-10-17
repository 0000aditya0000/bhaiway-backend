import { In, Repository } from 'typeorm';

import { UserProfile } from './entities/user-profile.entity';

export type UserDisplayNameSource = Pick<
  UserProfile,
  'displayName' | 'firstName' | 'lastName'
>;

/**
 * Authoritative admin/user-facing display name from UserProfile.
 * Prefer displayName; otherwise first + last. Never substitutes phone/email/id.
 */
export function resolveUserDisplayName(
  profile: UserDisplayNameSource | null | undefined,
): string | null {
  if (!profile) {
    return null;
  }
  const display = profile.displayName?.trim();
  if (display) {
    return display;
  }
  const first = profile.firstName?.trim() ?? '';
  const last = profile.lastName?.trim() ?? '';
  const combined = [first, last].filter((part) => part.length > 0).join(' ');
  return combined.length > 0 ? combined : null;
}

/** Batched lookup — one query for all userIds (avoids N+1). */
export async function loadUserDisplayNamesByUserIds(
  profileRepository: Repository<UserProfile>,
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds.filter((id) => Boolean(id)))];
  const map = new Map<string, string | null>();
  for (const id of unique) {
    map.set(id, null);
  }
  if (unique.length === 0) {
    return map;
  }

  const profiles = await profileRepository.find({
    where: { userId: In(unique) },
    select: {
      userId: true,
      displayName: true,
      firstName: true,
      lastName: true,
    },
  });

  for (const profile of profiles) {
    map.set(profile.userId, resolveUserDisplayName(profile));
  }
  return map;
}
