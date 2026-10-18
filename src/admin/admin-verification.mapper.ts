import { CorporateIdentityVerification } from '../corporate-identity/entities/corporate-identity-verification.entity';
import { CorporateIdentityStatus } from '../corporate-identity/enums/corporate-identity-status.enum';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VerificationType } from '../verification/enums/verification.enums';

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Full current verification row for admin detail (no government ID number fields exist on this entity). */
export function mapAdminUserVerification(row: UserVerification | undefined) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    verificationType: row.verificationType,
    status: row.status,
    provider: row.provider,
    providerReference: row.providerReference,
    documentUrl: row.documentUrl,
    documentType: row.documentType,
    documentReference: row.documentReference,
    isCurrent: row.isCurrent,
    submittedAt: iso(row.submittedAt),
    verifiedAt: iso(row.verifiedAt),
    rejectedAt: iso(row.rejectedAt),
    rejectionReason: row.rejectionReason,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapAdminCorporateVerification(
  row: CorporateIdentityVerification | null | undefined,
) {
  if (!row) {
    return {
      id: null,
      status: CorporateIdentityStatus.NOT_VERIFIED,
      corporateEmail: null,
      pendingCorporateEmail: null,
      verifiedAt: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    id: row.id,
    status: row.status,
    corporateEmail: row.corporateEmail,
    pendingCorporateEmail: row.pendingCorporateEmail,
    verifiedAt: iso(row.verifiedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapAdminVerificationBundle(
  verifications: UserVerification[],
  corporate: CorporateIdentityVerification | null | undefined,
) {
  const byType = new Map(
    verifications.map((v) => [v.verificationType, v] as const),
  );
  return {
    governmentId: mapAdminUserVerification(
      byType.get(VerificationType.IDENTITY),
    ),
    drivingLicence: mapAdminUserVerification(
      byType.get(VerificationType.DRIVING_LICENSE),
    ),
    vehicleRc: mapAdminUserVerification(byType.get(VerificationType.VEHICLE)),
    corporate: mapAdminCorporateVerification(corporate),
    current: verifications.map((v) => mapAdminUserVerification(v)),
  };
}
