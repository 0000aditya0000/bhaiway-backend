import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds AADHAAR_VERIFICATION_REWARD to the notifications type enum.
 * Wallet ledger already supports PROMOTIONAL credits — no wallet schema change.
 */
export class AadhaarVerificationRewardNotification1786585000000
  implements MigrationInterface
{
  name = 'AadhaarVerificationRewardNotification1786585000000';

  // PostgreSQL ADD VALUE cannot run inside a transaction block on older servers.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'AADHAAR_VERIFICATION_REWARD'
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Enum values are intentionally not removed.
  }
}
