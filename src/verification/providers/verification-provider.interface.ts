import { VerificationStatus, VerificationType } from '../enums/verification.enums';
import { Gender } from '../../users/entities/user-profile.entity';

export const VERIFICATION_PROVIDER = Symbol('VERIFICATION_PROVIDER');

export interface VerificationProviderSubmitInput {
  userId: string;
  verificationType: VerificationType;
  documentUrl?: string | null;
  documentType?: string | null;
  documentReference?: string | null;
}

export interface VerificationProviderSubmitResult {
  /** Logical provider name (e.g. stub, digilocker) — never a secret. */
  provider: string;
  providerReference: string;
  /**
   * Provider-authoritative outcome. When omitted, the service defaults to PENDING.
   * Clients never supply this.
   */
  status?: VerificationStatus;
  /**
   * Provider-authoritative gender from Aadhaar / KYC (IDENTITY only).
   * Clients never supply this. Mapped to UserProfile.gender on VERIFIED.
   */
  verifiedGender?: Gender | string | null;
}

/**
 * Abstraction for future external KYC / DL / RC providers.
 * The provider determines the verification outcome; clients cannot set status.
 */
export interface VerificationProvider {
  submitIdentity(
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult>;

  submitDrivingLicense(
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult>;

  submitVehicle(
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult>;
}
