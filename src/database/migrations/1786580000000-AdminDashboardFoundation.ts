import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminDashboardFoundation1786580000000
  implements MigrationInterface
{
  name = 'AdminDashboardFoundation1786580000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP WITH TIME ZONE
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_status"
      ON "rides" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_created_at"
      ON "rides" ("created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_cancelled_at"
      ON "rides" ("cancelled_at")
      WHERE "cancelled_at" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_completed_at"
      ON "rides" ("completed_at")
      WHERE "completed_at" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_type_created_at"
      ON "rides" ("ride_type", "created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_transactions_platform_revenue"
      ON "wallet_transactions" ("wallet_id", "transaction_type", "created_at")
      WHERE "status" = 'POSTED'
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."admin_alert_severity_enum" AS ENUM(
          'CRITICAL',
          'WARNING',
          'INFO'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."admin_alert_status_enum" AS ENUM(
          'OPEN',
          'ACKNOWLEDGED',
          'RESOLVED'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin_users" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "permissions" text array NOT NULL DEFAULT '{}',
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_admin_users_user_id" UNIQUE ("user_id"),
        CONSTRAINT "FK_admin_users_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin_alerts" (
        "id" uuid NOT NULL,
        "category" character varying(50) NOT NULL,
        "severity" "public"."admin_alert_severity_enum" NOT NULL,
        "status" "public"."admin_alert_status_enum" NOT NULL DEFAULT 'OPEN',
        "title" character varying(255) NOT NULL,
        "message" text NOT NULL,
        "source" character varying(100) NOT NULL,
        "incident_key" character varying(255) NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "acknowledged_at" TIMESTAMP WITH TIME ZONE,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by_user_id" uuid,
        CONSTRAINT "PK_admin_alerts" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_admin_alerts_open_incident"
      ON "admin_alerts" ("incident_key")
      WHERE "status" IN ('OPEN', 'ACKNOWLEDGED')
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_admin_alerts_status_severity"
      ON "admin_alerts" ("status", "severity", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_admin_alerts_created_at"
      ON "admin_alerts" ("created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin_activity_events" (
        "id" uuid NOT NULL,
        "event_type" character varying(80) NOT NULL,
        "category" character varying(50) NOT NULL,
        "severity" "public"."admin_alert_severity_enum" NOT NULL DEFAULT 'INFO',
        "title" character varying(255) NOT NULL,
        "description" text NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_activity_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_admin_activity_events_created_at"
      ON "admin_activity_events" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_admin_activity_events_created_at"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "admin_activity_events"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_admin_alerts_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_admin_alerts_status_severity"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_admin_alerts_open_incident"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "admin_alerts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "admin_users"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."admin_alert_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."admin_alert_severity_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_wallet_transactions_platform_revenue"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_type_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_completed_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_cancelled_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_status"`);
    await queryRunner.query(
      `ALTER TABLE "rides" DROP COLUMN IF EXISTS "completed_at"`,
    );
  }
}
