import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Driver Assured-deposit catalog coupons:
 * - persist original/final deposit + redemption on rides
 * - index coupon_redemptions.ride_id for driver publish lookups
 *
 * Do not run against production from this change set.
 */
export class DriverAssuredDepositCoupons1786630000000
  implements MigrationInterface
{
  name = 'DriverAssuredDepositCoupons1786630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "coupon_redemption_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "original_assured_deposit_amount" bigint
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "coupon_discount_amount" bigint
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_coupon_redemption_id"
      ON "rides" ("coupon_redemption_id")
      WHERE "coupon_redemption_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_redemptions_ride_id"
      ON "coupon_redemptions" ("ride_id")
      WHERE "ride_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_coupon_redemptions_ride_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_rides_coupon_redemption_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "coupon_discount_amount"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "original_assured_deposit_amount"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "coupon_redemption_id"
    `);
  }
}
