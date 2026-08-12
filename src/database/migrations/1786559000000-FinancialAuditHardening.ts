import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Financial audit hardening (post Phase 4):
 * - PLATFORM_SEED ledger for opening float
 * - reconcile platform balance from lots
 * - unique ACTIVE hold per business reference
 * - prevent coupon USED → UNUSED
 *
 * Does not modify AssuredLifecyclePhase4. Phase 4 down() remains incomplete
 * for enums/platform seed by design (forward-only).
 */
export class FinancialAuditHardening1786559000000
  implements MigrationInterface
{
  name = 'FinancialAuditHardening1786559000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."wallet_transactions_transaction_type_enum"
      ADD VALUE IF NOT EXISTS 'PLATFORM_SEED'
    `);

    // Opening float ledger (idempotent). Does not create additional points —
    // balances/lots already exist from Phase 4; this only audits the seed.
    await queryRunner.query(`
      INSERT INTO "wallet_transactions" (
        "id", "wallet_id", "user_id",
        "transaction_type", "point_source", "direction",
        "amount", "balance_before", "balance_after",
        "reference_type", "reference_id",
        "parent_transaction_id", "idempotency_key", "status", "created_at"
      )
      SELECT
        '00000000-0000-4000-8000-000000000005',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000001',
        'PLATFORM_SEED',
        'PURCHASED',
        'CREDIT',
        '10000000',
        '0',
        '10000000',
        'PLATFORM_SEED',
        'platform-operating-float',
        NULL,
        'platform-seed:opening-float',
        'POSTED',
        COALESCE(
          (SELECT "created_at" FROM "wallet_point_lots"
           WHERE "id" = '00000000-0000-4000-8000-000000000004'),
          now()
        )
      WHERE EXISTS (
        SELECT 1 FROM "wallets"
        WHERE "id" = '00000000-0000-4000-8000-000000000002'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "wallet_transactions"
        WHERE "idempotency_key" = 'platform-seed:opening-float'
      )
    `);

    // Heal any balance↔lot drift on the platform wallet (e.g. unsafe test restores).
    await queryRunner.query(`
      UPDATE "wallet_balances" b
      SET
        "purchased_available" = COALESCE((
          SELECT SUM(l."available_amount"::bigint)
          FROM "wallet_point_lots" l
          WHERE l."wallet_id" = b."wallet_id" AND l."source_type" = 'PURCHASED'
        ), 0),
        "promotional_available" = COALESCE((
          SELECT SUM(l."available_amount"::bigint)
          FROM "wallet_point_lots" l
          WHERE l."wallet_id" = b."wallet_id" AND l."source_type" = 'PROMOTIONAL'
        ), 0),
        "driver_earned_available" = COALESCE((
          SELECT SUM(l."available_amount"::bigint)
          FROM "wallet_point_lots" l
          WHERE l."wallet_id" = b."wallet_id" AND l."source_type" = 'DRIVER_EARNED'
        ), 0),
        "purchased_held" = COALESCE((
          SELECT SUM(l."held_amount"::bigint)
          FROM "wallet_point_lots" l
          WHERE l."wallet_id" = b."wallet_id" AND l."source_type" = 'PURCHASED'
        ), 0),
        "promotional_held" = COALESCE((
          SELECT SUM(l."held_amount"::bigint)
          FROM "wallet_point_lots" l
          WHERE l."wallet_id" = b."wallet_id" AND l."source_type" = 'PROMOTIONAL'
        ), 0),
        "driver_earned_held" = COALESCE((
          SELECT SUM(l."held_amount"::bigint)
          FROM "wallet_point_lots" l
          WHERE l."wallet_id" = b."wallet_id" AND l."source_type" = 'DRIVER_EARNED'
        ), 0),
        "updated_at" = now()
      WHERE b."wallet_id" = '00000000-0000-4000-8000-000000000002'
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_holds_active_reference"
      ON "wallet_holds" ("reference_type", "reference_id")
      WHERE "status" = 'ACTIVE'
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_user_coupon_unuse()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.status = 'USED' AND NEW.status = 'UNUSED' THEN
          RAISE EXCEPTION 'user_coupons status cannot transition from USED to UNUSED';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_prevent_user_coupon_unuse ON "user_coupons"
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_prevent_user_coupon_unuse
      BEFORE UPDATE ON "user_coupons"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_user_coupon_unuse()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_prevent_user_coupon_unuse ON "user_coupons"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS prevent_user_coupon_unuse()
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_wallet_holds_active_reference"
    `);
    await queryRunner.query(`
      DELETE FROM "wallet_transactions"
      WHERE "idempotency_key" = 'platform-seed:opening-float'
    `);
    // PLATFORM_SEED enum value and platform balance heal are not reversed
    // (PostgreSQL cannot drop enum values safely; balance heal is corrective).
  }
}
