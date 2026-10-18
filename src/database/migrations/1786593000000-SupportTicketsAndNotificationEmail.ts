import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Help & Support tickets + notification email outbox.
 * Adds support ticket tables and SUPPORT_* notification types.
 * Email delivery is keyed 1:1 to notifications for idempotency.
 */
export class SupportTicketsAndNotificationEmail1786593000000
  implements MigrationInterface
{
  name = 'SupportTicketsAndNotificationEmail1786593000000';

  // ADD VALUE IF NOT EXISTS cannot run inside a transaction on some PG versions.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'SUPPORT_TICKET_CREATED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'SUPPORT_TICKET_IN_PROGRESS'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'SUPPORT_TICKET_RESOLVED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'SUPPORT_TICKET_COMMENT'
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."support_tickets_category_enum" AS ENUM(
        'BOOKINGS_AND_RIDES',
        'PAYMENTS_AND_WALLETS',
        'OTHERS'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."support_tickets_status_enum" AS ENUM(
        'CREATED',
        'IN_PROGRESS',
        'RESOLVED'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."support_ticket_comments_author_type_enum" AS ENUM(
        'USER',
        'ADMIN'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."notification_email_deliveries_status_enum" AS ENUM(
        'PENDING',
        'SENT',
        'SKIPPED',
        'FAILED'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "support_tickets" (
        "id" uuid NOT NULL,
        "reference" character varying(32) NOT NULL,
        "user_id" uuid NOT NULL,
        "category" "public"."support_tickets_category_enum" NOT NULL,
        "subcategory" character varying(64) NOT NULL,
        "subject" character varying(200) NOT NULL,
        "description" text NOT NULL,
        "status" "public"."support_tickets_status_enum" NOT NULL DEFAULT 'CREATED',
        "related_ride_id" uuid,
        "related_booking_id" uuid,
        "related_wallet_transaction_id" uuid,
        "assignee_admin_user_id" uuid,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "idempotency_key" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_tickets_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_support_tickets_reference"
      ON "support_tickets" ("reference")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_support_tickets_user_id"
      ON "support_tickets" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_support_tickets_status"
      ON "support_tickets" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_support_tickets_category"
      ON "support_tickets" ("category")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_support_tickets_updated_at"
      ON "support_tickets" ("updated_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_support_tickets_user_updated"
      ON "support_tickets" ("user_id", "updated_at", "id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_support_tickets_user_idempotency"
      ON "support_tickets" ("user_id", "idempotency_key")
      WHERE "idempotency_key" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "support_tickets"
      ADD CONSTRAINT "FK_support_tickets_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "support_tickets"
      ADD CONSTRAINT "FK_support_tickets_related_ride_id"
      FOREIGN KEY ("related_ride_id") REFERENCES "rides"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "support_tickets"
      ADD CONSTRAINT "FK_support_tickets_related_booking_id"
      FOREIGN KEY ("related_booking_id") REFERENCES "bookings"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "support_tickets"
      ADD CONSTRAINT "FK_support_tickets_related_wallet_tx_id"
      FOREIGN KEY ("related_wallet_transaction_id") REFERENCES "wallet_transactions"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "support_ticket_comments" (
        "id" uuid NOT NULL,
        "ticket_id" uuid NOT NULL,
        "author_user_id" uuid NOT NULL,
        "author_type" "public"."support_ticket_comments_author_type_enum" NOT NULL,
        "message" text NOT NULL,
        "is_internal" boolean NOT NULL DEFAULT false,
        "idempotency_key" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_ticket_comments_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_support_ticket_comments_ticket_id"
      ON "support_ticket_comments" ("ticket_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_support_ticket_comments_ticket_created"
      ON "support_ticket_comments" ("ticket_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_support_ticket_comments_ticket_idempotency"
      ON "support_ticket_comments" ("ticket_id", "idempotency_key")
      WHERE "idempotency_key" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "support_ticket_comments"
      ADD CONSTRAINT "FK_support_ticket_comments_ticket_id"
      FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "support_ticket_comments"
      ADD CONSTRAINT "FK_support_ticket_comments_author_user_id"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "support_ticket_status_history" (
        "id" uuid NOT NULL,
        "ticket_id" uuid NOT NULL,
        "from_status" "public"."support_tickets_status_enum",
        "to_status" "public"."support_tickets_status_enum" NOT NULL,
        "changed_by_user_id" uuid,
        "changed_by_admin" boolean NOT NULL DEFAULT false,
        "note" character varying(500),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_ticket_status_history_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_support_ticket_status_history_ticket_id"
      ON "support_ticket_status_history" ("ticket_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "support_ticket_status_history"
      ADD CONSTRAINT "FK_support_ticket_status_history_ticket_id"
      FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "support_ticket_attachments" (
        "id" uuid NOT NULL,
        "ticket_id" uuid NOT NULL,
        "uploaded_by_user_id" uuid NOT NULL,
        "url" character varying(2048) NOT NULL,
        "content_type" character varying(64) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_ticket_attachments_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_support_ticket_attachments_ticket_id"
      ON "support_ticket_attachments" ("ticket_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "support_ticket_attachments"
      ADD CONSTRAINT "FK_support_ticket_attachments_ticket_id"
      FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "support_ticket_attachments"
      ADD CONSTRAINT "FK_support_ticket_attachments_uploaded_by"
      FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "notification_email_deliveries" (
        "id" uuid NOT NULL,
        "notification_id" uuid NOT NULL,
        "status" "public"."notification_email_deliveries_status_enum" NOT NULL DEFAULT 'PENDING',
        "recipient_email" character varying(255),
        "skip_reason" character varying(255),
        "attempt_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE,
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "failed_at" TIMESTAMP WITH TIME ZONE,
        "failure_reason" character varying(500),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_email_deliveries_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_notification_email_deliveries_notification_id"
      ON "notification_email_deliveries" ("notification_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_notification_email_deliveries_status_next"
      ON "notification_email_deliveries" ("status", "next_attempt_at")
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_email_deliveries"
      ADD CONSTRAINT "FK_notification_email_deliveries_notification_id"
      FOREIGN KEY ("notification_id") REFERENCES "notifications"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_email_deliveries"
      DROP CONSTRAINT "FK_notification_email_deliveries_notification_id"
    `);
    await queryRunner.query(`DROP TABLE "notification_email_deliveries"`);
    await queryRunner.query(
      `DROP TYPE "public"."notification_email_deliveries_status_enum"`,
    );

    await queryRunner.query(`
      ALTER TABLE "support_ticket_attachments"
      DROP CONSTRAINT "FK_support_ticket_attachments_uploaded_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "support_ticket_attachments"
      DROP CONSTRAINT "FK_support_ticket_attachments_ticket_id"
    `);
    await queryRunner.query(`DROP TABLE "support_ticket_attachments"`);

    await queryRunner.query(`
      ALTER TABLE "support_ticket_status_history"
      DROP CONSTRAINT "FK_support_ticket_status_history_ticket_id"
    `);
    await queryRunner.query(`DROP TABLE "support_ticket_status_history"`);

    await queryRunner.query(`
      ALTER TABLE "support_ticket_comments"
      DROP CONSTRAINT "FK_support_ticket_comments_author_user_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "support_ticket_comments"
      DROP CONSTRAINT "FK_support_ticket_comments_ticket_id"
    `);
    await queryRunner.query(`DROP TABLE "support_ticket_comments"`);
    await queryRunner.query(
      `DROP TYPE "public"."support_ticket_comments_author_type_enum"`,
    );

    await queryRunner.query(`
      ALTER TABLE "support_tickets"
      DROP CONSTRAINT "FK_support_tickets_related_wallet_tx_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "support_tickets"
      DROP CONSTRAINT "FK_support_tickets_related_booking_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "support_tickets"
      DROP CONSTRAINT "FK_support_tickets_related_ride_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "support_tickets"
      DROP CONSTRAINT "FK_support_tickets_user_id"
    `);
    await queryRunner.query(`DROP TABLE "support_tickets"`);
    await queryRunner.query(`DROP TYPE "public"."support_tickets_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."support_tickets_category_enum"`);
    // Notification enum values are intentionally not removed.
  }
}
