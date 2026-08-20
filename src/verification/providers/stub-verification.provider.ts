import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { VerificationStatus } from '../enums/verification.enums';
import type {
  VerificationProvider,
  VerificationProviderSubmitInput,
  VerificationProviderSubmitResult,
} from './verification-provider.interface';

/**
 * Development/staging stub — simulates a successful KYC outcome immediately
 * for identity, driving license, and vehicle submissions.
 * Does not contact any external KYC / Digilocker / RC / MSG91 API.
 * A real provider will later return PENDING / IN_REVIEW / VERIFIED / REJECTED.
 *
 * When this provider is active, VerificationService may auto-submit missing
 * DL / vehicle verifications after identity verification or vehicle creation
 * so publisher flows can be tested end-to-end without client-supplied status.
 */
@Injectable()
export class StubVerificationProvider implements VerificationProvider {
  async submitIdentity(
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult> {
    return this.submit('identity', input);
  }

  async submitDrivingLicense(
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult> {
    return this.submit('driving-license', input);
  }

  async submitVehicle(
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult> {
    return this.submit('vehicle', input);
  }

  private async submit(
    kind: string,
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult> {
    return {
      provider: 'stub',
      providerReference: `stub-${kind}-${input.userId}-${randomUUID()}`,
      status: VerificationStatus.VERIFIED,
    };
  }
}
