import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Coupon rider/driver eligibility (`applicable_to`).
 * Distinct from assignment `audience` (PUBLIC / USER_SPECIFIC).
 * Existing rows default to ALL so current coupons stay redeemable.
 *
 * Do not run against production from this change set.
 */
export class CouponApplicableTo1786620000000 implements MigrationInterface {
  name = 'CouponApplicableTo1786620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "coupons"
      ADD COLUMN IF NOT EXISTS "applicable_to" character varying(32) NOT NULL DEFAULT 'ALL'
    `);

    await queryRunner.query(`
      UPDATE "coupons"
      SET "applicable_to" = 'ALL'
      WHERE "applicable_to" IS NULL
         OR "applicable_to" NOT IN ('ALL', 'DRIVERS_ONLY', 'RIDERS_ONLY')
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "coupons"
        ADD CONSTRAINT "CHK_coupons_applicable_to"
        CHECK ("applicable_to" IN ('ALL', 'DRIVERS_ONLY', 'RIDERS_ONLY'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "coupons"
      DROP CONSTRAINT IF EXISTS "CHK_coupons_applicable_to"
    `);
    await queryRunner.query(`
      ALTER TABLE "coupons"
      DROP COLUMN IF EXISTS "applicable_to"
    `);
  }
}
