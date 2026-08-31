import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommuteBookingFoundation1786570000000 implements MigrationInterface {
  name = 'CommuteBookingFoundation1786570000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."bookings_booking_mode_enum"
      ADD VALUE IF NOT EXISTS 'COMMUTE'
    `);

    await queryRunner.query(`
      ALTER TYPE "public"."bookings_cancellation_reason_enum"
      ADD VALUE IF NOT EXISTS 'DRIVER_REJECTED'
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "driver_price_per_seat_snapshot" bigint
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "rider_price_per_seat_snapshot" bigint
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "driver_share_amount" bigint
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "platform_share_amount" bigint
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "platform_share_amount"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "driver_share_amount"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "rider_price_per_seat_snapshot"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "driver_price_per_seat_snapshot"
    `);
    // PostgreSQL enum values cannot be removed safely; forward-only migration.
  }
}
