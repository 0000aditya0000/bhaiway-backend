import { MigrationInterface, QueryRunner } from 'typeorm';

export class AssuredPassengerCancellationPhase11786568000000
  implements MigrationInterface
{
  name = 'AssuredPassengerCancellationPhase11786568000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."passenger_assured_deposit_penalties_reason_enum" AS ENUM(
        'PREVIOUS_ASSURED_CANCELLATION'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "passenger_assured_deposit_penalties" (
        "user_id" uuid NOT NULL,
        "elevated_percentage" integer NOT NULL,
        "reason" "public"."passenger_assured_deposit_penalties_reason_enum" NOT NULL,
        "source_cancellation_booking_id" uuid NOT NULL,
        "consumed_on_booking_id" uuid,
        "cleared_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_passenger_assured_deposit_penalties" PRIMARY KEY ("user_id"),
        CONSTRAINT "FK_passenger_assured_deposit_penalties_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_passenger_assured_deposit_penalties_user_id"
      ON "passenger_assured_deposit_penalties" ("user_id")
    `);

    await queryRunner.query(`
      ALTER TYPE "public"."wallet_transactions_transaction_type_enum"
      ADD VALUE IF NOT EXISTS 'ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."wallet_transactions_transaction_type_enum"
      ADD VALUE IF NOT EXISTS 'ASSURED_PASSENGER_CANCEL_FARE_DRIVER'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."wallet_transactions_transaction_type_enum"
      ADD VALUE IF NOT EXISTS 'ASSURED_PASSENGER_CANCEL_FARE_PLATFORM'
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "assured_deposit_reason" varchar(50)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "assured_deposit_reason"
    `);
    await queryRunner.query(`DROP TABLE "passenger_assured_deposit_penalties"`);
    await queryRunner.query(
      `DROP TYPE "public"."passenger_assured_deposit_penalties_reason_enum"`,
    );
  }
}
