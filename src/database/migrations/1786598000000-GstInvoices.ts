import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GST tax invoices for eligible completed Regular (Outstation) and Commute
 * bookings. Issuer/tax configuration is admin-managed; issued invoices snapshot
 * legal details and are not rewritten when configuration later changes.
 *
 * Booking/ride FKs use ON DELETE CASCADE so test teardown can remove bookings.
 * Production does not delete completed bookings.
 */
export class GstInvoices1786598000000 implements MigrationInterface {
  name = 'GstInvoices1786598000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."invoice_tax_pricing_mode_enum" AS ENUM(
        'TAX_EXCLUSIVE',
        'TAX_INCLUSIVE'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."invoice_place_of_supply_mode_enum" AS ENUM(
        'ISSUER_STATE',
        'RECIPIENT_STATE'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."invoice_tax_config_status_enum" AS ENUM(
        'DRAFT',
        'ACTIVE',
        'INACTIVE'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."invoice_gst_split_enum" AS ENUM(
        'CGST_SGST',
        'IGST'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."invoice_email_status_enum" AS ENUM(
        'PENDING',
        'SENT',
        'FAILED',
        'SKIPPED'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."invoice_job_status_enum" AS ENUM(
        'PENDING',
        'PROCESSING',
        'ISSUED',
        'FAILED',
        'SKIPPED'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "invoice_issuer_settings" (
        "id" uuid NOT NULL,
        "legal_name" character varying(255) NOT NULL,
        "gstin" character varying(15) NOT NULL,
        "address_line1" character varying(255) NOT NULL,
        "address_line2" character varying(255),
        "city" character varying(100) NOT NULL,
        "state" character varying(100) NOT NULL,
        "state_code" character varying(2) NOT NULL,
        "pin_code" character varying(6) NOT NULL,
        "contact_email" character varying(255),
        "contact_phone" character varying(20),
        "invoice_prefix" character varying(16) NOT NULL,
        "logo_storage_key" character varying(512),
        "footer_notes" text,
        "updated_by_admin_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invoice_issuer_settings_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "invoice_tax_configs" (
        "id" uuid NOT NULL,
        "service_category" character varying(120) NOT NULL,
        "ride_types" text[] NOT NULL,
        "sac_code" character varying(6) NOT NULL,
        "gst_rate_basis_points" integer NOT NULL,
        "pricing_mode" "public"."invoice_tax_pricing_mode_enum" NOT NULL,
        "place_of_supply_mode" "public"."invoice_place_of_supply_mode_enum" NOT NULL,
        "effective_from" TIMESTAMP WITH TIME ZONE NOT NULL,
        "effective_to" TIMESTAMP WITH TIME ZONE,
        "status" "public"."invoice_tax_config_status_enum" NOT NULL DEFAULT 'DRAFT',
        "notes" text,
        "created_by_admin_user_id" uuid,
        "updated_by_admin_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invoice_tax_configs_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_invoice_tax_configs_rate"
          CHECK ("gst_rate_basis_points" >= 1 AND "gst_rate_basis_points" <= 4000),
        CONSTRAINT "CHK_invoice_tax_configs_window"
          CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
        CONSTRAINT "CHK_invoice_tax_configs_ride_types"
          CHECK ("ride_types" <@ ARRAY['REGULAR','COMMUTE']::text[])
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_invoice_tax_configs_status_from"
      ON "invoice_tax_configs" ("status", "effective_from")
    `);

    await queryRunner.query(`
      CREATE TABLE "invoice_tax_config_audit" (
        "id" uuid NOT NULL,
        "tax_config_id" uuid NOT NULL,
        "admin_user_id" uuid,
        "action" character varying(40) NOT NULL,
        "snapshot" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invoice_tax_config_audit_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_invoice_tax_config_audit_config_id"
      ON "invoice_tax_config_audit" ("tax_config_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "invoice_tax_config_audit"
      ADD CONSTRAINT "FK_invoice_tax_config_audit_config"
      FOREIGN KEY ("tax_config_id") REFERENCES "invoice_tax_configs"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "invoice_number_sequences" (
        "series_prefix" character varying(16) NOT NULL,
        "financial_year" character varying(16) NOT NULL,
        "last_value" integer NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invoice_number_sequences"
          PRIMARY KEY ("series_prefix", "financial_year"),
        CONSTRAINT "CHK_invoice_number_sequences_last"
          CHECK ("last_value" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "gst_invoices" (
        "id" uuid NOT NULL,
        "invoice_number" character varying(48) NOT NULL,
        "ride_id" uuid NOT NULL,
        "booking_id" uuid NOT NULL,
        "rider_user_id" uuid NOT NULL,
        "ride_type" "public"."rides_ride_type_enum" NOT NULL,
        "rider_name" character varying(150),
        "rider_email" character varying(255),
        "rider_phone" character varying(20),
        "rider_billing_state_code" character varying(2),
        "driver_name" character varying(150),
        "vehicle_registration_number" character varying(20),
        "source" character varying(255) NOT NULL,
        "destination" character varying(255) NOT NULL,
        "departure_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "gross_fare_paise" bigint NOT NULL,
        "discount_paise" bigint NOT NULL,
        "net_fare_paise" bigint NOT NULL,
        "taxable_value_paise" bigint NOT NULL,
        "gst_rate_basis_points" integer NOT NULL,
        "cgst_paise" bigint NOT NULL,
        "sgst_paise" bigint NOT NULL,
        "igst_paise" bigint NOT NULL,
        "total_tax_paise" bigint NOT NULL,
        "invoice_total_paise" bigint NOT NULL,
        "pricing_mode" "public"."invoice_tax_pricing_mode_enum" NOT NULL,
        "gst_split" "public"."invoice_gst_split_enum" NOT NULL,
        "payment_status" "public"."bookings_payment_status_enum" NOT NULL,
        "payment_reference" character varying(64),
        "issuer_legal_name" character varying(255) NOT NULL,
        "issuer_gstin" character varying(15) NOT NULL,
        "issuer_address" character varying NOT NULL,
        "issuer_state" character varying(100) NOT NULL,
        "issuer_state_code" character varying(2) NOT NULL,
        "sac_code" character varying(6) NOT NULL,
        "service_category" character varying(120) NOT NULL,
        "place_of_supply_mode" "public"."invoice_place_of_supply_mode_enum" NOT NULL,
        "place_of_supply_state_code" character varying(2) NOT NULL,
        "tax_config_id" uuid NOT NULL,
        "tax_config_snapshot" jsonb NOT NULL,
        "currency" character varying(3) NOT NULL DEFAULT 'INR',
        "pdf_storage_key" character varying(512),
        "pdf_sha256" character varying(64),
        "email_status" "public"."invoice_email_status_enum" NOT NULL DEFAULT 'PENDING',
        "email_attempt_count" integer NOT NULL DEFAULT 0,
        "email_last_attempt_at" TIMESTAMP WITH TIME ZONE,
        "email_last_error" character varying(500),
        "email_sent_at" TIMESTAMP WITH TIME ZONE,
        "email_next_attempt_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gst_invoices_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_gst_invoices_amounts"
          CHECK (
            "gross_fare_paise" >= 0 AND "discount_paise" >= 0
            AND "net_fare_paise" >= 0 AND "taxable_value_paise" >= 0
            AND "cgst_paise" >= 0 AND "sgst_paise" >= 0 AND "igst_paise" >= 0
            AND "total_tax_paise" >= 0 AND "invoice_total_paise" >= 0
          )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_gst_invoices_booking_id"
      ON "gst_invoices" ("booking_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_gst_invoices_invoice_number"
      ON "gst_invoices" ("invoice_number")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_gst_invoices_rider_user_id"
      ON "gst_invoices" ("rider_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_gst_invoices_ride_id"
      ON "gst_invoices" ("ride_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_gst_invoices_issued_at"
      ON "gst_invoices" ("issued_at")
    `);
    await queryRunner.query(`
      ALTER TABLE "gst_invoices"
      ADD CONSTRAINT "FK_gst_invoices_ride_id"
      FOREIGN KEY ("ride_id") REFERENCES "rides"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "gst_invoices"
      ADD CONSTRAINT "FK_gst_invoices_booking_id"
      FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "gst_invoices"
      ADD CONSTRAINT "FK_gst_invoices_rider_user_id"
      FOREIGN KEY ("rider_user_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "gst_invoice_jobs" (
        "id" uuid NOT NULL,
        "ride_id" uuid NOT NULL,
        "booking_id" uuid NOT NULL,
        "invoice_id" uuid,
        "status" "public"."invoice_job_status_enum" NOT NULL DEFAULT 'PENDING',
        "attempt_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE,
        "last_error" character varying(500),
        "skip_reason" character varying(80),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gst_invoice_jobs_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_gst_invoice_jobs_booking_id"
      ON "gst_invoice_jobs" ("booking_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_gst_invoice_jobs_status_next"
      ON "gst_invoice_jobs" ("status", "next_attempt_at")
    `);
    await queryRunner.query(`
      ALTER TABLE "gst_invoice_jobs"
      ADD CONSTRAINT "FK_gst_invoice_jobs_ride_id"
      FOREIGN KEY ("ride_id") REFERENCES "rides"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "gst_invoice_jobs"
      ADD CONSTRAINT "FK_gst_invoice_jobs_booking_id"
      FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "gst_invoice_jobs"
      ADD CONSTRAINT "FK_gst_invoice_jobs_invoice_id"
      FOREIGN KEY ("invoice_id") REFERENCES "gst_invoices"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gst_invoice_jobs" DROP CONSTRAINT "FK_gst_invoice_jobs_invoice_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gst_invoice_jobs" DROP CONSTRAINT "FK_gst_invoice_jobs_booking_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gst_invoice_jobs" DROP CONSTRAINT "FK_gst_invoice_jobs_ride_id"`,
    );
    await queryRunner.query(`DROP TABLE "gst_invoice_jobs"`);

    await queryRunner.query(
      `ALTER TABLE "gst_invoices" DROP CONSTRAINT "FK_gst_invoices_rider_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gst_invoices" DROP CONSTRAINT "FK_gst_invoices_booking_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gst_invoices" DROP CONSTRAINT "FK_gst_invoices_ride_id"`,
    );
    await queryRunner.query(`DROP TABLE "gst_invoices"`);

    await queryRunner.query(`DROP TABLE "invoice_number_sequences"`);

    await queryRunner.query(
      `ALTER TABLE "invoice_tax_config_audit" DROP CONSTRAINT "FK_invoice_tax_config_audit_config"`,
    );
    await queryRunner.query(`DROP TABLE "invoice_tax_config_audit"`);
    await queryRunner.query(`DROP TABLE "invoice_tax_configs"`);
    await queryRunner.query(`DROP TABLE "invoice_issuer_settings"`);

    await queryRunner.query(`DROP TYPE "public"."invoice_job_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."invoice_email_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."invoice_gst_split_enum"`);
    await queryRunner.query(`DROP TYPE "public"."invoice_tax_config_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."invoice_place_of_supply_mode_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."invoice_tax_pricing_mode_enum"`);
  }
}
