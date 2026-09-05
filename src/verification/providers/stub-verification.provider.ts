import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { Gender } from '../../users/entities/user-profile.entity';
import { mapVerifiedGenderToEnum } from '../../users/gender-from-verification.mapper';
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
 *
 * For IDENTITY, returns verifiedGender from STUB_IDENTITY_GENDER (default FEMALE).
 * Real Digilocker/Aadhaar providers will return gender from the KYC payload.
 */
@Injectable()
export class StubVerificationProvider implements VerificationProvider {
  async submitIdentity(
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult> {
    return {
      provider: 'stub',
      providerReference: `stub-identity-${input.userId}-${randomUUID()}`,
      status: VerificationStatus.VERIFIED,
      verifiedGender: this.resolveStubIdentityGender(),
    };
  }

  async submitDrivingLicense(
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult> {
    return this.submitWithoutGender('driving-license', input);
  }

  async submitVehicle(
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult> {
    return this.submitWithoutGender('vehicle', input);
  }

  private async submitWithoutGender(
    kind: string,
    input: VerificationProviderSubmitInput,
  ): Promise<VerificationProviderSubmitResult> {
    return {
      provider: 'stub',
      providerReference: `stub-${kind}-${input.userId}-${randomUUID()}`,
      status: VerificationStatus.VERIFIED,
    };
  }

  private resolveStubIdentityGender(): Gender {
    const mapped = mapVerifiedGenderToEnum(
      process.env.STUB_IDENTITY_GENDER ?? Gender.FEMALE,
    );
    return mapped ?? Gender.FEMALE;
  }
}
