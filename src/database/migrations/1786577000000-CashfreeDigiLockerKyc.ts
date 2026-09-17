import { MigrationInterface, QueryRunner } from 'typeorm';

export class CashfreeDigiLockerKyc1786577000000 implements MigrationInterface {
  name = 'CashfreeDigiLockerKyc1786577000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."user_identity_verifications_status_enum" AS ENUM(
          'NOT_STARTED',
          'INITIATED',
          'PENDING',
          'AUTHENTICATED',
          'DOCUMENT_FETCHING',
          'VERIFIED',
          'FAILED',
          'EXPIRED',
          'CONSENT_DENIED',
          'CONSENT_EXPIRED'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_identity_verifications" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "provider" character varying(50) NOT NULL DEFAULT 'CASHFREE',
        "verification_type" character varying(50) NOT NULL DEFAULT 'AADHAAR',
        "verification_id" character varying(100) NOT NULL,
        "reference_id" character varying(100),
        "status" "public"."user_identity_verifications_status_enum" NOT NULL DEFAULT 'INITIATED',
        "document_type" character varying(50) NOT NULL DEFAULT 'AADHAAR',
        "verification_url" text,
        "redirect_url" text,
        "url_expires_at" TIMESTAMP WITH TIME ZONE,
        "verified_name" character varying(255),
        "verified_gender" character varying(50),
        "verified_dob" character varying(50),
        "masked_aadhaar" character varying(50),
        "aadhaar_last4" character varying(4),
        "verified_mobile" character varying(20),
        "document_status" character varying(50),
        "document_consent" boolean,
        "consent_valid_until" TIMESTAMP WITH TIME ZONE,
        "failure_reason" text,
        "raw_status" character varying(100),
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_identity_verifications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_identity_verifications_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_identity_verifications_verification_id"
      ON "user_identity_verifications" ("verification_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_identity_verifications_user_id"
      ON "user_identity_verifications" ("user_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_identity_verifications_provider_type"
      ON "user_identity_verifications" ("provider", "verification_type");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_identity_verifications_reference_id"
      ON "user_identity_verifications" ("reference_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_identity_verifications_status"
      ON "user_identity_verifications" ("status");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cashfree_webhook_events" (
        "id" uuid NOT NULL,
        "provider" character varying(50) NOT NULL DEFAULT 'CASHFREE',
        "event_type" character varying(100) NOT NULL,
        "verification_id" character varying(100),
        "reference_id" character varying(100),
        "event_time" TIMESTAMP WITH TIME ZONE,
        "payload_hash" character varying(64) NOT NULL,
        "processed" boolean NOT NULL DEFAULT false,
        "processed_at" TIMESTAMP WITH TIME ZONE,
        "failure_reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cashfree_webhook_events" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_cashfree_webhook_events_provider_payload_hash"
      ON "cashfree_webhook_events" ("provider", "payload_hash");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cashfree_webhook_events_verification_id"
      ON "cashfree_webhook_events" ("verification_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cashfree_webhook_events_reference_id"
      ON "cashfree_webhook_events" ("reference_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_cashfree_webhook_events_reference_id";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_cashfree_webhook_events_verification_id";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_cashfree_webhook_events_provider_payload_hash";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "cashfree_webhook_events";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_user_identity_verifications_status";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_user_identity_verifications_reference_id";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_user_identity_verifications_provider_type";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_user_identity_verifications_user_id";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_user_identity_verifications_verification_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "user_identity_verifications" DROP CONSTRAINT IF EXISTS "FK_user_identity_verifications_user_id";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "user_identity_verifications";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "public"."user_identity_verifications_status_enum";
    `);
  }
}
