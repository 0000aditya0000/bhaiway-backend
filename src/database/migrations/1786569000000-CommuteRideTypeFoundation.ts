import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommuteRideTypeFoundation1786569000000 implements MigrationInterface {
  name = 'CommuteRideTypeFoundation1786569000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."rides_ride_type_enum"
      ADD VALUE IF NOT EXISTS 'COMMUTE'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL enum values cannot be removed safely; forward-only migration.
  }
}
