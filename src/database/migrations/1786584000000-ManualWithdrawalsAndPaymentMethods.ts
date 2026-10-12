import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manual withdrawals + saved payout methods (no payout gateway).
 * Idempotent (IF NOT EXISTS) so it is safe to re-run after a partial apply.
 */
export class ManualWithdrawalsAndPaymentMethods1786584000000
  implements MigrationInterface
{
  name = 'ManualWithdrawalsAndPaymentMethods1786584000000';

  // PostgreSQL ADD VALUE cannot run inside a transaction block on older servers.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of [
      'WITHDRAWAL_INITIATED',
      'WITHDRAWAL_PROCESSING',
      'WITHDRAWAL_COMPLETED',
    ]) {
      await queryRunner.query(`
        ALTER TYPE "public"."notifications_type_enum"
        ADD VALUE IF NOT EXISTS '${value}'
      `);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_payment_methods" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "type" character varying(32) NOT NULL,
        "upi_id" character varying(255),
        "account_holder_name" character varying(255),
        "account_number_encrypted" text,
        "account_number_last4" character varying(4),
        "ifsc_code" character varying(11),
        "bank_name" character varying(255),
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_payment_methods" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_user_payment_methods_type"
          CHECK ("type" IN ('UPI', 'BANK_ACCOUNT')),
        CONSTRAINT "FK_user_payment_methods_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_payment_methods_user_id"
      ON "user_payment_methods" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_payment_methods_user_active"
      ON "user_payment_methods" ("user_id", "is_active")
    `);

    // Some environments still carry the table from an abandoned payout-gateway
    // prototype (beneficiary_id / provider_* columns). Preserve it under a legacy
    // name (renaming its indexes, which are schema-global) so the manual
    // withdrawals table below can be created cleanly.
    await queryRunner.query(`
      DO $$
      DECLARE idx record;
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'withdrawals'
            AND column_name = 'beneficiary_id'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'withdrawals_legacy_payout'
        ) THEN
          ALTER TABLE "withdrawals" RENAME TO "withdrawals_legacy_payout";
          FOR idx IN
            SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'withdrawals_legacy_payout'
          LOOP
            EXECUTE format(
              'ALTER INDEX %I RENAME TO %I',
              idx.indexname,
              idx.indexname || '_legacy'
            );
          END LOOP;
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "withdrawals" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "wallet_id" uuid NOT NULL,
        "amount" bigint NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'INITIATED',
        "provider" character varying(32) NOT NULL DEFAULT 'MANUAL',
        "payment_method_id" uuid,
        "payment_method_type" character varying(32) NOT NULL,
        "payment_method_snapshot" jsonb NOT NULL,
        "wallet_hold_id" uuid,
        "wallet_transaction_id" uuid,
        "reference_id" character varying(32) NOT NULL,
        "idempotency_key" character varying(255) NOT NULL,
        "admin_remarks" text,
        "processed_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_withdrawals" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_withdrawals_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "CHK_withdrawals_status" CHECK (
          "status" IN ('INITIATED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')
        ),
        CONSTRAINT "CHK_withdrawals_payment_method_type"
          CHECK ("payment_method_type" IN ('UPI', 'BANK_ACCOUNT')),
        CONSTRAINT "FK_withdrawals_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_withdrawals_wallet_id"
          FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_withdrawals_payment_method_id"
          FOREIGN KEY ("payment_method_id") REFERENCES "user_payment_methods"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_withdrawals_user_id"
      ON "withdrawals" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_withdrawals_status"
      ON "withdrawals" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_withdrawals_created_at"
      ON "withdrawals" ("created_at")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_withdrawals_reference_id"
      ON "withdrawals" ("reference_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_withdrawals_user_idempotency_key"
      ON "withdrawals" ("user_id", "idempotency_key")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "withdrawal_status_history" (
        "id" uuid NOT NULL,
        "withdrawal_id" uuid NOT NULL,
        "previous_status" character varying(32),
        "new_status" character varying(32) NOT NULL,
        "admin_user_id" uuid,
        "remarks" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_withdrawal_status_history" PRIMARY KEY ("id"),
        CONSTRAINT "FK_withdrawal_status_history_withdrawal_id"
          FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_withdrawal_status_history_admin_user_id"
          FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_withdrawal_status_history_withdrawal_id"
      ON "withdrawal_status_history" ("withdrawal_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_withdrawal_status_history_created_at"
      ON "withdrawal_status_history" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_withdrawal_status_history_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_withdrawal_status_history_withdrawal_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "withdrawal_status_history"`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_withdrawals_user_idempotency_key"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_withdrawals_reference_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_withdrawals_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_withdrawals_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_withdrawals_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "withdrawals"`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_user_payment_methods_user_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_user_payment_methods_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "user_payment_methods"`);

    // Enum values added to notifications_type_enum are intentionally not removed
    // (PostgreSQL cannot drop enum labels without recreating the type).
  }
}
