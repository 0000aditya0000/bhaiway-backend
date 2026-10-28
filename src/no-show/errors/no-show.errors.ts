import { ConflictException, HttpStatus } from '@nestjs/common';

import {
  SupportBookingsSubcategory,
  SupportTicketCategory,
} from '../../support/enums/support.enums';
import { NoShowClaimKind } from '../enums/no-show.enums';

export const NO_SHOW_CLAIM_ALREADY_REJECTED = 'NO_SHOW_CLAIM_ALREADY_REJECTED';

const REJECTED_SUPPORT_MESSAGE =
  'This claim was rejected. Open Help & Support to continue. No No-Show penalties, refunds, or cancellation were applied.';

export class NoShowClaimAlreadyRejectedError extends ConflictException {
  constructor(kind: NoShowClaimKind) {
    super({
      statusCode: HttpStatus.CONFLICT,
      code: NO_SHOW_CLAIM_ALREADY_REJECTED,
      message:
        'A No-Show claim for this trip has already been reviewed and rejected. Please contact Help & Support. No additional No-Show claim can be filed.',
      error: 'Conflict',
      support: {
        category: SupportTicketCategory.BOOKINGS_AND_RIDES,
        subcategory:
          kind === NoShowClaimKind.DRIVER_NO_SHOW
            ? SupportBookingsSubcategory.DRIVER_BEHAVIOUR
            : SupportBookingsSubcategory.OTHER,
        message: REJECTED_SUPPORT_MESSAGE,
      },
    });
  }
}
