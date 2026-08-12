import { MigrationInterface, QueryRunner } from 'typeorm';

export class BookingPaymentIntegration1786556400000
  implements MigrationInterface
{
  name = 'BookingPaymentIntegration1786556400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."bookings_payment_method_enum" AS ENUM('PAY_NOW', 'PAY_LATER')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."bookings_payment_status_enum" AS ENUM('UNPAID', 'PAID')`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD "payment_method" "public"."bookings_payment_method_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD "payment_status" "public"."bookings_payment_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD "idempotency_key" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD "wallet_transaction_id" uuid`,
    );

    // Backfill existing Phase-1 bookings as PAY_LATER / UNPAID
    await queryRunner.query(
      `UPDATE "bookings" SET "payment_method" = 'PAY_LATER', "payment_status" = 'UNPAID' WHERE "payment_method" IS NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "bookings" ALTER COLUMN "payment_method" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ALTER COLUMN "payment_status" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_bookings_idempotency_key" ON "bookings" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "FK_bookings_wallet_transaction_id" FOREIGN KEY ("wallet_transaction_id") REFERENCES "wallet_transactions"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT "FK_bookings_wallet_transaction_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_bookings_idempotency_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP COLUMN "wallet_transaction_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP COLUMN "idempotency_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP COLUMN "payment_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP COLUMN "payment_method"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."bookings_payment_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."bookings_payment_method_enum"`,
    );
  }
}
