import { MigrationInterface, QueryRunner } from 'typeorm';

export class RatingTasksFoundation1786572000000 implements MigrationInterface {
  name = 'RatingTasksFoundation1786572000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."rating_tasks_status_enum" AS ENUM('PENDING', 'COMPLETED')
    `);

    await queryRunner.query(`
      CREATE TABLE "rating_tasks" (
        "id" uuid NOT NULL,
        "ride_id" uuid NOT NULL,
        "booking_id" uuid NOT NULL,
        "from_user_id" uuid NOT NULL,
        "to_user_id" uuid NOT NULL,
        "status" "public"."rating_tasks_status_enum" NOT NULL DEFAULT 'PENDING',
        "rating" smallint,
        "comment" character varying(500),
        "skipped_at" TIMESTAMP WITH TIME ZONE,
        "last_reminded_at" TIMESTAMP WITH TIME ZONE,
        "reminder_count" integer NOT NULL DEFAULT 0,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_rating_tasks_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_rating_tasks_rating_range" CHECK (
          "rating" IS NULL OR ("rating" >= 1 AND "rating" <= 5)
        ),
        CONSTRAINT "CHK_rating_tasks_no_self_rating" CHECK ("from_user_id" <> "to_user_id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rating_tasks_booking_direction"
      ON "rating_tasks" ("booking_id", "from_user_id", "to_user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_rating_tasks_from_user_id" ON "rating_tasks" ("from_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_rating_tasks_to_user_id" ON "rating_tasks" ("to_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_rating_tasks_ride_id" ON "rating_tasks" ("ride_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_rating_tasks_booking_id" ON "rating_tasks" ("booking_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_rating_tasks_status" ON "rating_tasks" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_rating_tasks_last_reminded_at" ON "rating_tasks" ("last_reminded_at")
    `);

    await queryRunner.query(`
      ALTER TABLE "rating_tasks"
      ADD CONSTRAINT "FK_rating_tasks_ride_id"
      FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "rating_tasks"
      ADD CONSTRAINT "FK_rating_tasks_booking_id"
      FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "rating_tasks"
      ADD CONSTRAINT "FK_rating_tasks_from_user_id"
      FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "rating_tasks"
      ADD CONSTRAINT "FK_rating_tasks_to_user_id"
      FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rating_tasks" DROP CONSTRAINT "FK_rating_tasks_to_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating_tasks" DROP CONSTRAINT "FK_rating_tasks_from_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating_tasks" DROP CONSTRAINT "FK_rating_tasks_booking_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating_tasks" DROP CONSTRAINT "FK_rating_tasks_ride_id"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_rating_tasks_last_reminded_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_rating_tasks_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_rating_tasks_booking_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_rating_tasks_ride_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_rating_tasks_to_user_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_rating_tasks_from_user_id"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_rating_tasks_booking_direction"`);
    await queryRunner.query(`DROP TABLE "rating_tasks"`);
    await queryRunner.query(`DROP TYPE "public"."rating_tasks_status_enum"`);
  }
}
