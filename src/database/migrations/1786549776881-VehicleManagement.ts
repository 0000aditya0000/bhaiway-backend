import { MigrationInterface, QueryRunner } from 'typeorm';

export class VehicleManagement1786549776881 implements MigrationInterface {
  name = 'VehicleManagement1786549776881';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."vehicles_vehicle_type_enum" AS ENUM('CAR', 'BIKE')`,
    );
    await queryRunner.query(
      `CREATE TABLE "vehicles" ("id" uuid NOT NULL, "user_id" uuid NOT NULL, "vehicle_type" "public"."vehicles_vehicle_type_enum" NOT NULL, "make" character varying(100) NOT NULL, "model" character varying(100) NOT NULL, "variant" character varying(100), "registration_number" character varying(20) NOT NULL, "registration_year" integer, "color" character varying(50), "seating_capacity" integer NOT NULL, "document_url" text, "document_type" character varying(50), "document_reference" character varying(255), "is_active" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_18d8646b59304dce4af3a9e35b6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_vehicles_user_registration_active" ON "vehicles" ("user_id", "registration_number") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vehicles_user_id" ON "vehicles" ("user_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicles" ADD CONSTRAINT "FK_88b36924d769e4df751bcfbf249" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vehicles" DROP CONSTRAINT "FK_88b36924d769e4df751bcfbf249"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_vehicles_user_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_vehicles_user_registration_active"`,
    );
    await queryRunner.query(`DROP TABLE "vehicles"`);
    await queryRunner.query(`DROP TYPE "public"."vehicles_vehicle_type_enum"`);
  }
}
