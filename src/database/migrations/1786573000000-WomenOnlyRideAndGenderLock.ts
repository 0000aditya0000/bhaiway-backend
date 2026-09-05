import { MigrationInterface, QueryRunner } from 'typeorm';

export class WomenOnlyRideAndGenderLock1786573000000
  implements MigrationInterface
{
  name = 'WomenOnlyRideAndGenderLock1786573000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "women_only" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "women_only"
    `);
  }
}
