import { VerificationStatus, VerificationType } from './enums/verification.enums';

export interface VerificationStatusView {
  status: VerificationStatus;
  submittedAt: string | null;
  verifiedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  expiresAt: string | null;
}

export interface MyVerificationsResponse {
  identity: VerificationStatusView;
  drivingLicense: VerificationStatusView;
  vehicle: VerificationStatusView;
}

export interface RideEligibilityResult {
  allowed: boolean;
  missing: VerificationType[];
  /**
   * When canPublishRide is called with a vehicleId:
   * true if the vehicle exists, belongs to the user, is active, and is not deleted.
   * null when vehicleId is omitted (verification-only check).
   */
  vehicleEligible: boolean | null;
}

export interface TrustedVerificationDecision {
  status:
    | VerificationStatus.IN_REVIEW
    | VerificationStatus.VERIFIED
    | VerificationStatus.REJECTED
    | VerificationStatus.EXPIRED;
  rejectionReason?: string | null;
  expiresAt?: Date | null;
  providerReference?: string | null;
}
