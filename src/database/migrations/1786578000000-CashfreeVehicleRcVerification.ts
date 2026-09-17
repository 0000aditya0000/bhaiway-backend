import { MigrationInterface, QueryRunner } from 'typeorm';

export class CashfreeVehicleRcVerification1786578000000
  implements MigrationInterface
{
  name = 'CashfreeVehicleRcVerification1786578000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."vehicle_rc_verifications_status_enum" AS ENUM(
          'PENDING',
          'VALID',
          'INVALID',
          'FAILED'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vehicle_rc_verifications" (
        "id" uuid NOT NULL,
        "vehicle_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "provider" character varying(50) NOT NULL DEFAULT 'CASHFREE',
        "verification_id" character varying(100) NOT NULL,
        "reference_id" character varying(100),
        "requested_vehicle_number" character varying(50) NOT NULL,
        "verified_vehicle_number" character varying(50),
        "status" "public"."vehicle_rc_verifications_status_enum" NOT NULL DEFAULT 'PENDING',
        "rc_status" character varying(50),
        "owner_name" character varying(255),
        "owner_count" character varying(50),
        "vehicle_class" character varying(100),
        "manufacturer_name" character varying(150),
        "model" character varying(150),
        "vehicle_color" character varying(50),
        "fuel_type" character varying(50),
        "body_type" character varying(100),
        "vehicle_category" character varying(50),
        "chassis" character varying(100),
        "engine" character varying(100),
        "registration_date" character varying(50),
        "manufacturing_month_year" character varying(50),
        "rc_expiry_date" character varying(50),
        "insurance_company" character varying(255),
        "insurance_valid_until" character varying(50),
        "financer" character varying(255),
        "is_commercial" boolean,
        "seat_capacity" integer,
        "pucc_number" character varying(100),
        "pucc_valid_until" character varying(50),
        "blacklist_status" character varying(100),
        "owner_match_status" character varying(50) NOT NULL DEFAULT 'NOT_CHECKED',
        "failure_code" character varying(100),
        "failure_reason" text,
        "raw_response" jsonb,
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vehicle_rc_verifications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_vehicle_rc_verifications_vehicle_id" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_vehicle_rc_verifications_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_vehicle_rc_verifications_verification_id"
      ON "vehicle_rc_verifications" ("verification_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_vehicle_rc_verifications_vehicle_id"
      ON "vehicle_rc_verifications" ("vehicle_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_vehicle_rc_verifications_user_id"
      ON "vehicle_rc_verifications" ("user_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_vehicle_rc_verifications_requested_number"
      ON "vehicle_rc_verifications" ("requested_vehicle_number");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_vehicle_rc_verifications_reference_id"
      ON "vehicle_rc_verifications" ("reference_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_vehicle_rc_verifications_status"
      ON "vehicle_rc_verifications" ("status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_vehicle_rc_verifications_status";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_vehicle_rc_verifications_reference_id";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_vehicle_rc_verifications_requested_number";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_vehicle_rc_verifications_user_id";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_vehicle_rc_verifications_vehicle_id";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_vehicle_rc_verifications_verification_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "vehicle_rc_verifications" DROP CONSTRAINT IF EXISTS "FK_vehicle_rc_verifications_user_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "vehicle_rc_verifications" DROP CONSTRAINT IF EXISTS "FK_vehicle_rc_verifications_vehicle_id";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "vehicle_rc_verifications";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "public"."vehicle_rc_verifications_status_enum";
    `);
  }
}
