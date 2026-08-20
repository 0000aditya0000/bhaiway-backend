import { DataSource } from 'typeorm';

import { UserVerification } from '../entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../enums/verification.enums';
import { VerificationService } from '../verification.service';

export async function markVerificationVerified(
  verificationService: VerificationService,
  dataSource: DataSource,
  userId: string,
  type: VerificationType,
): Promise<void> {
  const existing = await dataSource.getRepository(UserVerification).findOne({
    where: { userId, verificationType: type, isCurrent: true },
  });

  if (existing?.status === VerificationStatus.VERIFIED) {
    return;
  }

  const dto = { documentType: `${type}_SCAN` };
  if (type === VerificationType.IDENTITY) {
    await verificationService.submitIdentityVerification(userId, dto);
  } else if (type === VerificationType.DRIVING_LICENSE) {
    await verificationService.submitDrivingLicenseVerification(userId, dto);
  } else {
    await verificationService.submitVehicleVerification(userId, dto);
  }

  const record = await dataSource
    .getRepository(UserVerification)
    .findOneByOrFail({
      userId,
      verificationType: type,
      isCurrent: true,
    });

  if (record.status !== VerificationStatus.VERIFIED) {
    await verificationService.applyTrustedVerificationDecision(record.id, {
      status: VerificationStatus.VERIFIED,
    });
  }
}

export async function rejectVerification(
  verificationService: VerificationService,
  dataSource: DataSource,
  userId: string,
  type: VerificationType,
  reason = 'Test rejection',
): Promise<void> {
  const record = await dataSource
    .getRepository(UserVerification)
    .findOneByOrFail({
      userId,
      verificationType: type,
      isCurrent: true,
    });

  await verificationService.applyTrustedVerificationDecision(record.id, {
    status: VerificationStatus.REJECTED,
    rejectionReason: reason,
  });
}
