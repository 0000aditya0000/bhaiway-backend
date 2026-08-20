import { VerificationStatus } from '../enums/verification.enums';
import { VerificationType } from '../enums/verification.enums';
import { StubVerificationProvider } from './stub-verification.provider';

describe('StubVerificationProvider', () => {
  const provider = new StubVerificationProvider();

  it('simulates successful identity verification without calling MSG91', async () => {
    const result = await provider.submitIdentity({
      userId: 'user-1',
      verificationType: VerificationType.IDENTITY,
      documentType: 'IDENTITY_SCAN',
    });

    expect(result.provider).toBe('stub');
    expect(result.providerReference).toMatch(/^stub-identity-user-1-/);
    expect(result.status).toBe(VerificationStatus.VERIFIED);
  });

  it('simulates successful driving license verification', async () => {
    const result = await provider.submitDrivingLicense({
      userId: 'user-1',
      verificationType: VerificationType.DRIVING_LICENSE,
      documentType: 'DL_SCAN',
    });

    expect(result.provider).toBe('stub');
    expect(result.providerReference).toMatch(/^stub-driving-license-user-1-/);
    expect(result.status).toBe(VerificationStatus.VERIFIED);
  });

  it('simulates successful vehicle verification', async () => {
    const result = await provider.submitVehicle({
      userId: 'user-1',
      verificationType: VerificationType.VEHICLE,
      documentType: 'RC_SCAN',
      documentReference: 'vehicle-123',
    });

    expect(result.provider).toBe('stub');
    expect(result.providerReference).toMatch(/^stub-vehicle-user-1-/);
    expect(result.status).toBe(VerificationStatus.VERIFIED);
  });
});
