import { MigrationInterface, QueryRunner } from 'typeorm';

export class NotificationFoundation1786575000000 implements MigrationInterface {
  name = 'NotificationFoundation1786575000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."notification_devices_platform_enum" AS ENUM('ANDROID', 'IOS')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."notifications_type_enum" AS ENUM(
        'BOOKING_RECEIVED',
        'BOOKING_CONFIRMED',
        'BOOKING_CANCELLED',
        'COMMUTE_BOOKING_REQUESTED',
        'COMMUTE_BOOKING_CONFIRMED',
        'COMMUTE_BOOKING_CANCELLED',
        'ASSURED_RIDE_PUBLISHED',
        'WALLET_CREDITED',
        'CHAT_MESSAGE'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."notifications_status_enum" AS ENUM('PENDING', 'SENT', 'FAILED')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."notifications_provider_enum" AS ENUM('FCM', 'MOCK')
    `);

    await queryRunner.query(`
      CREATE TABLE "notification_devices" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "token" character varying(512) NOT NULL,
        "platform" "public"."notification_devices_platform_enum" NOT NULL,
        "device_id" character varying(255),
        "app_version" character varying(64),
        "is_active" boolean NOT NULL DEFAULT true,
        "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_devices_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_notification_devices_token"
      ON "notification_devices" ("token")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_notification_devices_user_id"
      ON "notification_devices" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_notification_devices_user_active"
      ON "notification_devices" ("user_id", "is_active")
    `);

    await queryRunner.query(`
      ALTER TABLE "notification_devices"
      ADD CONSTRAINT "FK_notification_devices_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL,
        "recipient_user_id" uuid NOT NULL,
        "type" "public"."notifications_type_enum" NOT NULL,
        "title" character varying(200) NOT NULL,
        "body" character varying(500) NOT NULL,
        "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "status" "public"."notifications_status_enum" NOT NULL DEFAULT 'PENDING',
        "idempotency_key" character varying(255) NOT NULL,
        "provider" "public"."notifications_provider_enum" NOT NULL DEFAULT 'FCM',
        "provider_message_id" character varying(255),
        "attempt_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "failed_at" TIMESTAMP WITH TIME ZONE,
        "failure_reason" character varying(500),
        "read_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_notifications_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_notifications_idempotency_key"
      ON "notifications" ("idempotency_key")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_recipient_user_id"
      ON "notifications" ("recipient_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_status"
      ON "notifications" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_type"
      ON "notifications" ("type")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_created_at"
      ON "notifications" ("created_at")
    `);

    await queryRunner.query(`
      ALTER TABLE "notifications"
      ADD CONSTRAINT "FK_notifications_recipient_user_id"
      FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notifications"
      DROP CONSTRAINT "FK_notifications_recipient_user_id"
    `);
    await queryRunner.query(`DROP TABLE "notifications"`);

    await queryRunner.query(`
      ALTER TABLE "notification_devices"
      DROP CONSTRAINT "FK_notification_devices_user_id"
    `);
    await queryRunner.query(`DROP TABLE "notification_devices"`);

    await queryRunner.query(
      `DROP TYPE "public"."notifications_provider_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."notifications_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."notifications_type_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."notification_devices_platform_enum"`,
    );
  }
}
