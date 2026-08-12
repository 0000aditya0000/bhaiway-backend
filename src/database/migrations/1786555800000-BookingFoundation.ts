import { MigrationInterface, QueryRunner } from 'typeorm';

export class BookingFoundation1786555800000 implements MigrationInterface {
  name = 'BookingFoundation1786555800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."bookings_status_enum" AS ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "bookings" ("id" uuid NOT NULL, "ride_id" uuid NOT NULL, "passenger_id" uuid NOT NULL, "seats" integer NOT NULL, "status" "public"."bookings_status_enum" NOT NULL DEFAULT 'CONFIRMED', "price_per_seat_snapshot" bigint NOT NULL, "total_amount" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_bookings_seats_positive" CHECK ("seats" > 0), CONSTRAINT "CHK_bookings_price_non_negative" CHECK ("price_per_seat_snapshot" >= 0), CONSTRAINT "CHK_bookings_total_non_negative" CHECK ("total_amount" >= 0), CONSTRAINT "PK_bookings_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bookings_passenger_id" ON "bookings" ("passenger_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bookings_ride_id" ON "bookings" ("ride_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_bookings_active_passenger_ride" ON "bookings" ("passenger_id", "ride_id") WHERE "status" IN ('PENDING', 'CONFIRMED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "FK_bookings_ride_id" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD CONSTRAINT "FK_bookings_passenger_id" FOREIGN KEY ("passenger_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT "FK_bookings_passenger_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP CONSTRAINT "FK_bookings_ride_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_bookings_active_passenger_ride"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_bookings_ride_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_bookings_passenger_id"`);
    await queryRunner.query(`DROP TABLE "bookings"`);
    await queryRunner.query(`DROP TYPE "public"."bookings_status_enum"`);
  }
}
