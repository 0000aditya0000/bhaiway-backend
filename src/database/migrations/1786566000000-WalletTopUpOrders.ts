import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wallet V1 Phase 1: payment_orders foundation for top-up flow.
 * Separate from wallet_transactions — no wallet credits in this migration.
 */
export class WalletTopUpOrders1786566000000 implements MigrationInterface {
  name = 'WalletTopUpOrders1786566000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."payment_orders_provider_enum" AS ENUM('MOCK')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."payment_orders_status_enum" AS ENUM(
        'PENDING',
        'SUCCESS',
        'FAILED',
        'CANCELLED'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "payment_orders" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "wallet_id" uuid NOT NULL,
        "amount" bigint NOT NULL,
        "currency" character varying(3) NOT NULL DEFAULT 'INR',
        "provider" "public"."payment_orders_provider_enum" NOT NULL,
        "gateway_order_id" character varying(255),
        "status" "public"."payment_orders_status_enum" NOT NULL DEFAULT 'PENDING',
        "idempotency_key" character varying(255),
        "wallet_transaction_id" uuid,
        "callback_reference" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_payment_orders_amount" CHECK ("amount" > 0),
        CONSTRAINT "PK_payment_orders" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_payment_orders_user_id"
      ON "payment_orders" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_payment_orders_status"
      ON "payment_orders" ("status")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_payment_orders_gateway_order_id"
      ON "payment_orders" ("gateway_order_id")
      WHERE "gateway_order_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_payment_orders_idempotency_key"
      ON "payment_orders" ("idempotency_key")
      WHERE "idempotency_key" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "payment_orders"
      ADD CONSTRAINT "FK_payment_orders_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "payment_orders"
      ADD CONSTRAINT "FK_payment_orders_wallet_id"
      FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "payment_orders"
      ADD CONSTRAINT "FK_payment_orders_wallet_transaction_id"
      FOREIGN KEY ("wallet_transaction_id") REFERENCES "wallet_transactions"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payment_orders"
      DROP CONSTRAINT IF EXISTS "FK_payment_orders_wallet_transaction_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "payment_orders"
      DROP CONSTRAINT IF EXISTS "FK_payment_orders_wallet_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "payment_orders"
      DROP CONSTRAINT IF EXISTS "FK_payment_orders_user_id"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_payment_orders_idempotency_key"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_payment_orders_gateway_order_id"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_payment_orders_status"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_payment_orders_user_id"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "payment_orders"
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "public"."payment_orders_status_enum"
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "public"."payment_orders_provider_enum"
    `);
  }
}
