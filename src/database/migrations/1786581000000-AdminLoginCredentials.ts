import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminLoginCredentials1786581000000 implements MigrationInterface {
  name = 'AdminLoginCredentials1786581000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "admin_users"
      ADD COLUMN IF NOT EXISTS "username" character varying(64)
    `);
    await queryRunner.query(`
      ALTER TABLE "admin_users"
      ADD COLUMN IF NOT EXISTS "password_hash" character varying(255)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_admin_users_username"
      ON "admin_users" ("username")
      WHERE "username" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_admin_users_username"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_users" DROP COLUMN IF EXISTS "password_hash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_users" DROP COLUMN IF EXISTS "username"`,
    );
  }
}
