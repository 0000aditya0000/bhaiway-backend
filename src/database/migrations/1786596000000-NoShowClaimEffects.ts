import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable outbox for No-Show post-commit effects (resolved notifications and
 * rejection support tickets). Settlement remains on no_show_claims; these rows
 * only track side effects that must be retried after commit.
 */
export class NoShowClaimEffects1786596000000 implements MigrationInterface {
  name = 'NoShowClaimEffects1786596000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."no_show_claim_effects_kind_enum" AS ENUM(
        'NOTIFY_RESOLVED',
        'OPEN_SUPPORT'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."no_show_claim_effects_status_enum" AS ENUM(
        'PENDING',
        'COMPLETED',
        'FAILED'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "no_show_claim_effects" (
        "id" uuid NOT NULL,
        "claim_id" uuid NOT NULL,
        "kind" "public"."no_show_claim_effects_kind_enum" NOT NULL,
        "status" "public"."no_show_claim_effects_status_enum" NOT NULL DEFAULT 'PENDING',
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "attempt_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_no_show_claim_effects" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_no_show_claim_effects_claim_kind" UNIQUE ("claim_id", "kind"),
        CONSTRAINT "FK_no_show_claim_effects_claim_id"
          FOREIGN KEY ("claim_id") REFERENCES "no_show_claims"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_no_show_claim_effects_claim_id"
      ON "no_show_claim_effects" ("claim_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_no_show_claim_effects_status_next_attempt"
      ON "no_show_claim_effects" ("status", "next_attempt_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_no_show_claim_effects_status_next_attempt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_no_show_claim_effects_claim_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "no_show_claim_effects"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."no_show_claim_effects_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."no_show_claim_effects_kind_enum"`,
    );
  }
}
