import { MigrationInterface, QueryRunner } from 'typeorm';

export class RidePublishing1786554752201 implements MigrationInterface {
  name = 'RidePublishing1786554752201';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."rides_ride_type_enum" AS ENUM('REGULAR', 'ASSURED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."rides_status_enum" AS ENUM('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "rides" ("id" uuid NOT NULL, "driver_id" uuid NOT NULL, "vehicle_id" uuid NOT NULL, "ride_type" "public"."rides_ride_type_enum" NOT NULL DEFAULT 'REGULAR', "status" "public"."rides_status_enum" NOT NULL DEFAULT 'PUBLISHED', "source" character varying(255) NOT NULL, "destination" character varying(255) NOT NULL, "departure_date" date NOT NULL, "departure_time" TIME NOT NULL, "total_seats" integer NOT NULL, "available_seats" integer NOT NULL, "price_per_seat" bigint NOT NULL, "max_two_in_back_seat" boolean NOT NULL DEFAULT false, "no_smoking" boolean NOT NULL DEFAULT false, "no_pets" boolean NOT NULL DEFAULT false, "luggage_allowed" boolean NOT NULL DEFAULT true, "notes" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_69eea07d7a114ad1791a483735" CHECK ("price_per_seat" >= 0), CONSTRAINT "CHK_0c64091e0216b5e26454f2c220" CHECK ("available_seats" <= "total_seats"), CONSTRAINT "CHK_62ad657cc87b04b4f11a7a95ca" CHECK ("available_seats" >= 0), CONSTRAINT "CHK_63bb9ea744fb24b75e0347008e" CHECK ("total_seats" > 0), CONSTRAINT "PK_ca6f62fc1e999b139c7f28f07fd" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_rides_departure_date" ON "rides" ("departure_date") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_rides_vehicle_id" ON "rides" ("vehicle_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_rides_driver_id" ON "rides" ("driver_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "rides" ADD CONSTRAINT "FK_fb13184768dea9734b022874c6f" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rides" ADD CONSTRAINT "FK_320dcf5ce88faadee00fee57f3e" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rides" DROP CONSTRAINT "FK_320dcf5ce88faadee00fee57f3e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rides" DROP CONSTRAINT "FK_fb13184768dea9734b022874c6f"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_rides_driver_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_rides_vehicle_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_rides_departure_date"`);
    await queryRunner.query(`DROP TABLE "rides"`);
    await queryRunner.query(`DROP TYPE "public"."rides_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."rides_ride_type_enum"`);
  }
}
