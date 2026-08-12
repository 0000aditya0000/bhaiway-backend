import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import type {
  VerificationProvider,
  VerificationProviderSubmitInput,
  VerificationProviderSubmitResult,
} from './verification-provider.interface';

/**
 * Stub provider — records a synthetic reference only.
 * Does not contact any external KYC / Digilocker / RC API.
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
    };
  }
}
