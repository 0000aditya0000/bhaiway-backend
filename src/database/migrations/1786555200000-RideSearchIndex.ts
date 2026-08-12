import { MigrationInterface, QueryRunner } from 'typeorm';

export class RideSearchIndex1786555200000 implements MigrationInterface {
  name = 'RideSearchIndex1786555200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_rides_search" ON "rides" ("status", "departure_date", "departure_time") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_rides_search"`);
  }
}
