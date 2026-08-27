import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Assured booking fare choice (PAY_NOW | PAY_LATER) independent of
 * the mandatory ASSURED_DEPOSIT security-deposit hold.
 */
export class AssuredBookingFarePayment1786567000000
  implements MigrationInterface
{
  name = 'AssuredBookingFarePayment1786567000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."bookings_fare_payment_method_enum" AS ENUM(
        'PAY_NOW',
        'PAY_LATER'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD "fare_payment_method" "public"."bookings_fare_payment_method_enum"
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD "fare_wallet_transaction_id" uuid
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD CONSTRAINT "FK_bookings_fare_wallet_transaction_id"
      FOREIGN KEY ("fare_wallet_transaction_id")
      REFERENCES "wallet_transactions"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION
    `);

    // Historical Assured deposit bookings left fare unpaid (= PAY_LATER).
    await queryRunner.query(`
      UPDATE "bookings"
      SET "fare_payment_method" = 'PAY_LATER'
      WHERE "payment_method" = 'ASSURED_DEPOSIT'
        AND "booking_mode" = 'ASSURED'
        AND "fare_payment_method" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings"
      DROP CONSTRAINT IF EXISTS "FK_bookings_fare_wallet_transaction_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      DROP COLUMN IF EXISTS "fare_wallet_transaction_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      DROP COLUMN IF EXISTS "fare_payment_method"
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "public"."bookings_fare_payment_method_enum"
    `);
  }
}
