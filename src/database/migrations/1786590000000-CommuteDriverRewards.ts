import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Office Commute driver reward campaigns, milestones, qualifying trips, claims.
 * Month windows use calendar months in campaign timezone (application logic).
 */
export class CommuteDriverRewards1786590000000 implements MigrationInterface {
  name = 'CommuteDriverRewards1786590000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "commute_reward_campaigns" (
        "id" uuid NOT NULL,
        "title" character varying(160) NOT NULL,
        "description" text,
        "banner_url" character varying(1024),
        "status" character varying(32) NOT NULL,
        "timezone" character varying(64) NOT NULL DEFAULT 'Asia/Kolkata',
        "starts_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "ends_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "config_version" integer NOT NULL DEFAULT 1,
        "created_by_admin_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commute_reward_campaigns" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_commute_reward_campaigns_dates"
          CHECK ("ends_at" > "starts_at")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_commute_reward_campaigns_status"
      ON "commute_reward_campaigns" ("status")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "commute_reward_milestones" (
        "id" uuid NOT NULL,
        "campaign_id" uuid NOT NULL,
        "sort_order" integer NOT NULL,
        "title" character varying(120) NOT NULL,
        "required_trips" integer NOT NULL,
        "window_type" character varying(48) NOT NULL
          DEFAULT 'CALENDAR_MONTHS_FROM_START',
        "window_months" integer NOT NULL,
        "prize_value_cap_inr" integer NOT NULL,
        "prize_description" text,
        "prize_image_url" character varying(1024),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commute_reward_milestones" PRIMARY KEY ("id"),
        CONSTRAINT "FK_commute_reward_milestones_campaign"
          FOREIGN KEY ("campaign_id") REFERENCES "commute_reward_campaigns"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "CHK_commute_reward_milestones_trips"
          CHECK ("required_trips" >= 1),
        CONSTRAINT "CHK_commute_reward_milestones_months"
          CHECK ("window_months" >= 1),
        CONSTRAINT "CHK_commute_reward_milestones_prize"
          CHECK ("prize_value_cap_inr" >= 0),
        CONSTRAINT "CHK_commute_reward_milestones_order"
          CHECK ("sort_order" >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_commute_reward_milestones_campaign_order"
      ON "commute_reward_milestones" ("campaign_id", "sort_order")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "commute_reward_qualifying_trips" (
        "id" uuid NOT NULL,
        "campaign_id" uuid NOT NULL,
        "driver_id" uuid NOT NULL,
        "ride_id" uuid NOT NULL,
        "completed_passenger_count" integer NOT NULL,
        "completed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "campaign_config_version" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commute_reward_qualifying_trips" PRIMARY KEY ("id"),
        CONSTRAINT "FK_commute_reward_qt_campaign"
          FOREIGN KEY ("campaign_id") REFERENCES "commute_reward_campaigns"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_commute_reward_qt_driver"
          FOREIGN KEY ("driver_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "CHK_commute_reward_qt_passengers"
          CHECK ("completed_passenger_count" >= 2)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_commute_reward_qualifying_trips_campaign_ride"
      ON "commute_reward_qualifying_trips" ("campaign_id", "ride_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_commute_reward_qualifying_trips_driver"
      ON "commute_reward_qualifying_trips"
        ("campaign_id", "driver_id", "completed_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "commute_reward_claims" (
        "id" uuid NOT NULL,
        "campaign_id" uuid NOT NULL,
        "driver_id" uuid NOT NULL,
        "milestone_id" uuid NOT NULL,
        "status" character varying(32) NOT NULL,
        "campaign_config_version" integer NOT NULL,
        "qualifying_trip_count_snapshot" integer NOT NULL,
        "prize_value_cap_inr_snapshot" integer NOT NULL,
        "prize_description_snapshot" text,
        "prize_snapshot" jsonb NOT NULL,
        "rejection_reason" text,
        "reviewed_by_admin_id" uuid,
        "claimed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "fulfilled_at" TIMESTAMP WITH TIME ZONE,
        "fulfilment_notes" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commute_reward_claims" PRIMARY KEY ("id"),
        CONSTRAINT "FK_commute_reward_claims_campaign"
          FOREIGN KEY ("campaign_id") REFERENCES "commute_reward_campaigns"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_commute_reward_claims_driver"
          FOREIGN KEY ("driver_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_commute_reward_claims_milestone"
          FOREIGN KEY ("milestone_id") REFERENCES "commute_reward_milestones"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_commute_reward_claims_campaign_driver_milestone"
      ON "commute_reward_claims" ("campaign_id", "driver_id", "milestone_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_commute_reward_claims_status"
      ON "commute_reward_claims" ("status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_commute_reward_claims_driver"
      ON "commute_reward_claims" ("driver_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "commute_reward_audit_logs" (
        "id" uuid NOT NULL,
        "campaign_id" uuid,
        "claim_id" uuid,
        "admin_id" uuid,
        "driver_id" uuid,
        "action" character varying(80) NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commute_reward_audit_logs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_commute_reward_audit_logs_campaign"
      ON "commute_reward_audit_logs" ("campaign_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_commute_reward_audit_logs_created"
      ON "commute_reward_audit_logs" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "commute_reward_audit_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "commute_reward_claims"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "commute_reward_qualifying_trips"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "commute_reward_milestones"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "commute_reward_campaigns"`);
  }
}
