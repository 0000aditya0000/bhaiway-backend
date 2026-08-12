export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

/**
 * Normalized identity after OTP-provider verification.
 * Phone/email must come from the provider's confirmed response mapping only.
 */
export interface VerifiedOtpUser {
  phone: string;
  email?: string;
  verified: boolean;
}

export interface OtpProvider {
  verifyAccessToken(accessToken: string): Promise<VerifiedOtpUser>;
}
