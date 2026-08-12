import { UserProfile } from './entities/user-profile.entity';

/**
 * Profile is complete when the entity-required field firstName is present.
 * Other UserProfile columns are nullable and are not required for completion.
 */
export function isProfileCompleted(
  profile: Pick<UserProfile, 'firstName'> | null | undefined,
): boolean {
  return Boolean(profile?.firstName?.trim());
}
