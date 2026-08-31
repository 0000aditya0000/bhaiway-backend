import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommuteCompletionSettlement1786571000000
  implements MigrationInterface
{
  name = 'CommuteCompletionSettlement1786571000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."wallet_transactions_transaction_type_enum"
      ADD VALUE IF NOT EXISTS 'COMMUTE_PLATFORM_MARGIN'
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "settled_at" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "settled_at"
    `);
    // PostgreSQL enum values cannot be removed safely; forward-only migration.
  }
}
