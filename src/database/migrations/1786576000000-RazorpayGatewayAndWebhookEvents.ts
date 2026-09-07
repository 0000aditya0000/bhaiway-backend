import { MigrationInterface, QueryRunner } from 'typeorm';

export class RazorpayGatewayAndWebhookEvents1786576000000
  implements MigrationInterface
{
  name = 'RazorpayGatewayAndWebhookEvents1786576000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."payment_orders_provider_enum" ADD VALUE IF NOT EXISTS 'RAZORPAY';
    `);

    await queryRunner.query(`
      ALTER TABLE "payment_orders"
      ADD COLUMN IF NOT EXISTS "gateway_payment_id" character varying(255),
      ADD COLUMN IF NOT EXISTS "gateway_signature" character varying(255),
      ADD COLUMN IF NOT EXISTS "gateway_status" character varying(50),
      ADD COLUMN IF NOT EXISTS "failure_reason" character varying(255),
      ADD COLUMN IF NOT EXISTS "metadata" jsonb;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payment_orders_gateway_payment_id"
      ON "payment_orders" ("gateway_payment_id")
      WHERE "gateway_payment_id" IS NOT NULL;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."payment_webhook_events_status_enum" AS ENUM(
          'PENDING',
          'PROCESSED',
          'FAILED',
          'IGNORED'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payment_webhook_events" (
        "id" uuid NOT NULL,
        "provider" "public"."payment_orders_provider_enum" NOT NULL,
        "event_id" character varying(255) NOT NULL,
        "event_type" character varying(100) NOT NULL,
        "status" "public"."payment_webhook_events_status_enum" NOT NULL DEFAULT 'PENDING',
        "gateway_order_id" character varying(255),
        "gateway_payment_id" character varying(255),
        "failure_reason" text,
        "payload" jsonb,
        "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMP WITH TIME ZONE,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payment_webhook_events" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payment_webhook_events_provider_event_id"
      ON "payment_webhook_events" ("provider", "event_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payment_webhook_events_gateway_order_id"
      ON "payment_webhook_events" ("gateway_order_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_payment_webhook_events_gateway_order_id";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_payment_webhook_events_provider_event_id";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "payment_webhook_events";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "public"."payment_webhook_events_status_enum";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_payment_orders_gateway_payment_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "payment_orders"
      DROP COLUMN IF EXISTS "metadata",
      DROP COLUMN IF EXISTS "failure_reason",
      DROP COLUMN IF EXISTS "gateway_status",
      DROP COLUMN IF EXISTS "gateway_signature",
      DROP COLUMN IF EXISTS "gateway_payment_id";
    `);
  }
}
