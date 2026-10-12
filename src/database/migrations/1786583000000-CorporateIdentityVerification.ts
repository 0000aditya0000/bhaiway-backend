import { MigrationInterface, QueryRunner } from 'typeorm';

export class CorporateIdentityVerification1786583000000
  implements MigrationInterface
{
  name = 'CorporateIdentityVerification1786583000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "email_verification_otps"
      ADD COLUMN IF NOT EXISTS "purpose" character varying(40) NOT NULL DEFAULT 'EMAIL_VERIFICATION'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_verification_otps_user_purpose_sent"
      ON "email_verification_otps" ("user_id", "purpose", "sent_at")
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_email_verification_otps_active"`,
    );
    // Personal email verification: one active OTP per user+email.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_verification_otps_active_personal"
      ON "email_verification_otps" ("user_id", "email")
      WHERE "verified_at" IS NULL
        AND "invalidated_at" IS NULL
        AND "purpose" = 'EMAIL_VERIFICATION'
    `);
    // Corporate identity: one active OTP per user (any target email).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_verification_otps_active_corporate"
      ON "email_verification_otps" ("user_id")
      WHERE "verified_at" IS NULL
        AND "invalidated_at" IS NULL
        AND "purpose" = 'CORPORATE_IDENTITY'
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "corporate_identity_verifications" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "corporate_email" character varying(255),
        "pending_corporate_email" character varying(255),
        "status" character varying(32) NOT NULL DEFAULT 'NOT_VERIFIED',
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_corporate_identity_verifications" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_corporate_identity_verifications_user_id" UNIQUE ("user_id"),
        CONSTRAINT "FK_corporate_identity_verifications_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_corporate_identity_verifications_user_id"
      ON "corporate_identity_verifications" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_corporate_identity_verifications_user_id"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "corporate_identity_verifications"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_email_verification_otps_active_corporate"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_email_verification_otps_active_personal"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_verification_otps_active"
      ON "email_verification_otps" ("user_id", "email")
      WHERE "verified_at" IS NULL AND "invalidated_at" IS NULL
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_email_verification_otps_user_purpose_sent"`,
    );
    await queryRunner.query(`
      ALTER TABLE "email_verification_otps"
      DROP COLUMN IF EXISTS "purpose"
    `);
  }
}
