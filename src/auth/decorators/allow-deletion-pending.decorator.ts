import { SetMetadata } from '@nestjs/common';

export const ALLOW_DELETION_PENDING_KEY = 'allowDeletionPending';

/**
 * Marks an endpoint as accessible to accounts that are currently in a deletion-pending state
 * (DELETION_REQUESTED, DELETION_ACTION_REQUIRED, DELETION_APPROVED), or authenticated with a
 * restricted deletion JWT.
 */
export const AllowDeletionPending = () =>
  SetMetadata(ALLOW_DELETION_PENDING_KEY, true);

