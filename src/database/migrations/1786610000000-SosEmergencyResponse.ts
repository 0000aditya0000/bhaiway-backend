import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SOS / emergency response tables, one-active-SOS-per-ride uniqueness,
 * and SOS notification types. Trusted-contact SMS is intentionally not added.
 */
export class SosEmergencyResponse1786610000000 implements MigrationInterface {
  name = 'SosEmergencyResponse1786610000000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'SOS_DRIVER_ALERT'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'SOS_PASSENGER_ALERT'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'SOS_ADDITIONAL_TRIGGER'
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."sos_status_enum" AS ENUM (
          'TRIGGERED', 'ACKNOWLEDGED', 'RESPONDING', 'RESOLVED', 'FALSE_ALARM'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."sos_severity_enum" AS ENUM ('CRITICAL');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."sos_category_enum" AS ENUM (
          'EMERGENCY', 'UNSAFE_DRIVER', 'ACCIDENT', 'MEDICAL', 'HARASSMENT', 'OTHER'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."sos_participant_role_enum" AS ENUM ('DRIVER', 'PASSENGER');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."sos_actor_type_enum" AS ENUM ('USER', 'ADMIN', 'SYSTEM');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."sos_timeline_event_type_enum" AS ENUM (
          'TRIGGERED', 'ADDITIONAL_TRIGGER', 'ACKNOWLEDGED', 'RESPONSE_STARTED',
          'NOTE_ADDED', 'ASSIGNED', 'ESCALATED', 'RESOLVED', 'FALSE_ALARM'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."safety_incident_status_enum" AS ENUM (
          'OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'ESCALATED', 'RESOLVED', 'CLOSED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."safety_incident_type_enum" AS ENUM ('SOS');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."safety_incident_severity_enum" AS ENUM (
          'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sos_events" (
        "id" uuid NOT NULL,
        "ride_id" uuid NOT NULL,
        "original_trigger_user_id" uuid NOT NULL,
        "category" "public"."sos_category_enum" NOT NULL DEFAULT 'EMERGENCY',
        "severity" "public"."sos_severity_enum" NOT NULL DEFAULT 'CRITICAL',
        "status" "public"."sos_status_enum" NOT NULL DEFAULT 'TRIGGERED',
        "ride_type" "public"."rides_ride_type_enum" NOT NULL,
        "triggered_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "acknowledged_at" TIMESTAMP WITH TIME ZONE,
        "acknowledged_by_admin_id" uuid,
        "response_started_at" TIMESTAMP WITH TIME ZONE,
        "response_started_by_admin_id" uuid,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by_admin_id" uuid,
        "resolution_reason" text,
        "false_alarm_at" TIMESTAMP WITH TIME ZONE,
        "false_alarm_by_admin_id" uuid,
        "trigger_latitude" double precision,
        "trigger_longitude" double precision,
        "trigger_accuracy" double precision,
        "trigger_location_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sos_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sos_events_ride_id"
          FOREIGN KEY ("ride_id") REFERENCES "rides"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_sos_events_original_trigger_user_id"
          FOREIGN KEY ("original_trigger_user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sos_events_ride_id" ON "sos_events" ("ride_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sos_events_status" ON "sos_events" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sos_events_triggered_at" ON "sos_events" ("triggered_at")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_sos_events_one_active_per_ride"
      ON "sos_events" ("ride_id")
      WHERE "status" IN ('TRIGGERED', 'ACKNOWLEDGED', 'RESPONDING')
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sos_triggers" (
        "id" uuid NOT NULL,
        "sos_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role" "public"."sos_participant_role_enum" NOT NULL,
        "is_original" boolean NOT NULL DEFAULT false,
        "triggered_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "trigger_source" character varying(50) NOT NULL DEFAULT 'APP',
        "idempotency_key" character varying(255),
        "latitude" double precision,
        "longitude" double precision,
        "accuracy" double precision,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sos_triggers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sos_triggers_sos_id"
          FOREIGN KEY ("sos_id") REFERENCES "sos_events"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_sos_triggers_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sos_triggers_sos_id" ON "sos_triggers" ("sos_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sos_triggers_user_id" ON "sos_triggers" ("user_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_sos_triggers_idempotency_key"
      ON "sos_triggers" ("idempotency_key")
      WHERE "idempotency_key" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sos_participants" (
        "id" uuid NOT NULL,
        "sos_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role" "public"."sos_participant_role_enum" NOT NULL,
        "display_name" character varying(150),
        "phone" character varying(20),
        "profile_photo" text,
        "booking_id" uuid,
        "booking_status" character varying(32),
        "pickup_status" character varying(32),
        "vehicle_id" uuid,
        "vehicle_make" character varying(100),
        "vehicle_model" character varying(100),
        "vehicle_registration_number" character varying(20),
        "vehicle_color" character varying(50),
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sos_participants" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sos_participants_sos_id"
          FOREIGN KEY ("sos_id") REFERENCES "sos_events"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_sos_participants_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_sos_participants_sos_user"
      ON "sos_participants" ("sos_id", "user_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sos_timeline_events" (
        "id" uuid NOT NULL,
        "sos_id" uuid NOT NULL,
        "event_type" "public"."sos_timeline_event_type_enum" NOT NULL,
        "actor_type" "public"."sos_actor_type_enum" NOT NULL,
        "actor_id" uuid,
        "description" text NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sos_timeline_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sos_timeline_events_sos_id"
          FOREIGN KEY ("sos_id") REFERENCES "sos_events"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sos_timeline_events_sos_id"
      ON "sos_timeline_events" ("sos_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sos_timeline_events_created_at"
      ON "sos_timeline_events" ("created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sos_notes" (
        "id" uuid NOT NULL,
        "sos_id" uuid NOT NULL,
        "author_admin_user_id" uuid NOT NULL,
        "author_user_id" uuid NOT NULL,
        "body" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sos_notes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sos_notes_sos_id"
          FOREIGN KEY ("sos_id") REFERENCES "sos_events"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sos_notes_sos_id" ON "sos_notes" ("sos_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "safety_incidents" (
        "id" uuid NOT NULL,
        "sos_id" uuid,
        "ride_id" uuid NOT NULL,
        "type" "public"."safety_incident_type_enum" NOT NULL,
        "status" "public"."safety_incident_status_enum" NOT NULL,
        "severity" "public"."safety_incident_severity_enum" NOT NULL,
        "title" character varying(255) NOT NULL,
        "summary" text,
        "assigned_admin_user_id" uuid,
        "assigned_at" TIMESTAMP WITH TIME ZONE,
        "escalated_at" TIMESTAMP WITH TIME ZONE,
        "escalated_by_admin_user_id" uuid,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by_admin_user_id" uuid,
        "resolution_note" text,
        "closed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_safety_incidents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_safety_incidents_sos_id"
          FOREIGN KEY ("sos_id") REFERENCES "sos_events"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_safety_incidents_ride_id"
          FOREIGN KEY ("ride_id") REFERENCES "rides"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_safety_incidents_status"
      ON "safety_incidents" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_safety_incidents_type"
      ON "safety_incidents" ("type")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_safety_incidents_sos_id"
      ON "safety_incidents" ("sos_id")
      WHERE "sos_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "safety_incident_notes" (
        "id" uuid NOT NULL,
        "incident_id" uuid NOT NULL,
        "author_admin_user_id" uuid NOT NULL,
        "author_user_id" uuid NOT NULL,
        "body" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_safety_incident_notes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_safety_incident_notes_incident_id"
          FOREIGN KEY ("incident_id") REFERENCES "safety_incidents"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_safety_incident_notes_incident_id"
      ON "safety_incident_notes" ("incident_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "safety_incident_notes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "safety_incidents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sos_notes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sos_timeline_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sos_participants"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sos_triggers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sos_events"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."safety_incident_severity_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."safety_incident_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."safety_incident_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."sos_timeline_event_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."sos_actor_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."sos_participant_role_enum"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."sos_category_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."sos_severity_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."sos_status_enum"`);
  }
}
