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
});
