import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChangeEmailVerification1786640000000 implements MigrationInterface {
  name = 'ChangeEmailVerification1786640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_verification_otps_active_change_email"
      ON "email_verification_otps" ("user_id")
      WHERE "verified_at" IS NULL
        AND "invalidated_at" IS NULL
        AND "purpose" = 'CHANGE_EMAIL'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_email_verification_otps_active_change_email"`,
    );
  }
}
