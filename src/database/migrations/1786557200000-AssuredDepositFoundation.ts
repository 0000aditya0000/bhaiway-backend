import { MigrationInterface, QueryRunner } from 'typeorm';

export class AssuredDepositFoundation1786557200000
  implements MigrationInterface
{
  name = 'AssuredDepositFoundation1786557200000';

  // Enum ADD VALUE cannot run inside a transaction on some PostgreSQL versions.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "app_settings" (
        "key" character varying(100) NOT NULL,
        "value" character varying(255) NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_settings_key" PRIMARY KEY ("key")
      )
    `);

    await queryRunner.query(`
      INSERT INTO "app_settings" ("key", "value")
      VALUES ('ASSURED_RIDE_DEPOSIT_PERCENTAGE', '5')
    `);

    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD "assured_deposit_percentage" integer
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD "assured_deposit_amount" bigint
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD "driver_deposit_hold_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD CONSTRAINT "FK_rides_driver_deposit_hold_id"
      FOREIGN KEY ("driver_deposit_hold_id")
      REFERENCES "wallet_holds"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD "assured_deposit_percentage" integer
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD "assured_deposit_amount" bigint
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD "wallet_hold_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD CONSTRAINT "FK_bookings_wallet_hold_id"
      FOREIGN KEY ("wallet_hold_id")
      REFERENCES "wallet_holds"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      ALTER TYPE "public"."bookings_payment_method_enum"
      ADD VALUE 'ASSURED_DEPOSIT'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP CONSTRAINT "FK_bookings_wallet_hold_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN "wallet_hold_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN "assured_deposit_amount"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN "assured_deposit_percentage"
    `);

    await queryRunner.query(`
      ALTER TABLE "rides" DROP CONSTRAINT "FK_rides_driver_deposit_hold_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN "driver_deposit_hold_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN "assured_deposit_amount"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN "assured_deposit_percentage"
    `);

    await queryRunner.query(`DROP TABLE "app_settings"`);
  }
}
