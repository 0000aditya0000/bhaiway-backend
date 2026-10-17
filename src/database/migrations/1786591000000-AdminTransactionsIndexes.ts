import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin transaction browser + safe single admin reversal per original ledger row.
 * Partial unique index scopes to ADMIN_TX_REVERSAL so hold release/consume
 * parent_transaction_id links remain unaffected.
 */
export class AdminTransactionsIndexes1786591000000
  implements MigrationInterface
{
  name = 'AdminTransactionsIndexes1786591000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_transactions_created_at_id"
      ON "wallet_transactions" ("created_at" DESC, "id" DESC)
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_wallet_transactions_admin_reversal_parent"
      ON "wallet_transactions" ("parent_transaction_id")
      WHERE "reference_type" = 'ADMIN_TX_REVERSAL'
        AND "parent_transaction_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_wallet_transactions_admin_reversal_parent"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_wallet_transactions_created_at_id"
    `);
  }
}
