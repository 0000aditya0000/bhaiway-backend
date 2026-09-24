import { MigrationInterface, QueryRunner } from 'typeorm';

export class EmailVerificationOtps1786579000000 implements MigrationInterface {
  name = 'EmailVerificationOtps1786579000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_verification_otps" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "email" character varying(255) NOT NULL,
        "otp_hash" character varying(255) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "max_attempts" integer NOT NULL DEFAULT 5,
        "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "invalidated_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_verification_otps" PRIMARY KEY ("id"),
        CONSTRAINT "FK_email_verification_otps_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_verification_otps_user_id"
      ON "email_verification_otps" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_verification_otps_email"
      ON "email_verification_otps" ("email")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_verification_otps_user_sent"
      ON "email_verification_otps" ("user_id", "sent_at")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_verification_otps_active"
      ON "email_verification_otps" ("user_id", "email")
      WHERE "verified_at" IS NULL AND "invalidated_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_email_verification_otps_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_email_verification_otps_user_sent"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_email_verification_otps_email"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_email_verification_otps_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "email_verification_otps"`);
  }
}
