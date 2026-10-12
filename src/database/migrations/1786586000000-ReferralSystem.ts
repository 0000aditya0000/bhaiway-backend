import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Referral system:
 * - users.referral_code (unique, nullable for lazy backfill)
 * - referrals table (one referrer per referred user)
 * - notification types for referrer / referred rewards
 */
export class ReferralSystem1786586000000 implements MigrationInterface {
  name = 'ReferralSystem1786586000000';

  // PostgreSQL ADD VALUE cannot run inside a transaction block on older servers.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of [
      'REFERRAL_REWARD_REFERRER',
      'REFERRAL_REWARD_REFERRED',
    ]) {
      await queryRunner.query(`
        ALTER TYPE "public"."notifications_type_enum"
        ADD VALUE IF NOT EXISTS '${value}'
      `);
    }

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "referral_code" character varying(32)
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_referral_code"
      ON "users" ("referral_code")
      WHERE "referral_code" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "referrals" (
        "id" uuid NOT NULL,
        "referrer_user_id" uuid NOT NULL,
        "referred_user_id" uuid NOT NULL,
        "referral_code" character varying(32) NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'REWARDED',
        "reward_coins" bigint NOT NULL DEFAULT 50,
        "rewarded_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_referrals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_referrals_referred_user_id" UNIQUE ("referred_user_id"),
        CONSTRAINT "FK_referrals_referrer_user_id"
          FOREIGN KEY ("referrer_user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_referrals_referred_user_id"
          FOREIGN KEY ("referred_user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_referrals_referrer_user_id"
      ON "referrals" ("referrer_user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_referrals_referral_code"
      ON "referrals" ("referral_code")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_referrals_referral_code"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_referrals_referrer_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "referrals"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_users_referral_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "referral_code"`,
    );
    // Enum values are intentionally not removed.
  }
}
