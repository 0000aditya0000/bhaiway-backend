import { VerificationType } from '../enums/verification.enums';

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
}

/**
 * Abstraction for future external KYC / DL / RC providers.
 * No real provider is wired in this phase.
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
