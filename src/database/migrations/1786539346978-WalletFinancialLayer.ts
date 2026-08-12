import { MigrationInterface, QueryRunner } from "typeorm";

export class WalletFinancialLayer1786539346978 implements MigrationInterface {
    name = 'WalletFinancialLayer1786539346978'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."wallet_point_lots_source_type_enum" AS ENUM('PURCHASED', 'PROMOTIONAL', 'DRIVER_EARNED')`);
        await queryRunner.query(`CREATE TABLE "wallet_point_lots" ("id" uuid NOT NULL, "wallet_id" uuid NOT NULL, "source_type" "public"."wallet_point_lots_source_type_enum" NOT NULL, "original_amount" bigint NOT NULL, "available_amount" bigint NOT NULL, "held_amount" bigint NOT NULL DEFAULT '0', "expires_at" TIMESTAMP WITH TIME ZONE, "reference_type" character varying(50), "reference_id" character varying(255), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_2c68d1d00d542469bbd625457f" CHECK ("available_amount" + "held_amount" <= "original_amount"), CONSTRAINT "CHK_6b8406b9b49e52f889e6d006c9" CHECK ("held_amount" >= 0), CONSTRAINT "CHK_1e39999c64b869f9b7d2a48b61" CHECK ("available_amount" >= 0), CONSTRAINT "CHK_dca8db34f5dc4b7c4617a28f46" CHECK ("original_amount" > 0), CONSTRAINT "PK_5aedf988f2ef5e58bd3fb9c76bf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_wallet_point_lots_expires_at" ON "wallet_point_lots"  ("expires_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_wallet_point_lots_wallet_id" ON "wallet_point_lots"  ("wallet_id") `);
        await queryRunner.query(`CREATE TABLE "wallet_balances" ("id" uuid NOT NULL, "wallet_id" uuid NOT NULL, "purchased_available" bigint NOT NULL DEFAULT '0', "promotional_available" bigint NOT NULL DEFAULT '0', "driver_earned_available" bigint NOT NULL DEFAULT '0', "purchased_held" bigint NOT NULL DEFAULT '0', "promotional_held" bigint NOT NULL DEFAULT '0', "driver_earned_held" bigint NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_df71d0f9058318ebc25302aa36" UNIQUE ("wallet_id"), CONSTRAINT "CHK_8aba02ece3846122a4ca771a53" CHECK ("purchased_available" >= 0 AND "promotional_available" >= 0 AND "driver_earned_available" >= 0 AND "purchased_held" >= 0 AND "promotional_held" >= 0 AND "driver_earned_held" >= 0), CONSTRAINT "PK_eebe2c6f13f1a2de3457f8a885c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."wallet_holds_hold_type_enum" AS ENUM('ASSURED_DEPOSIT', 'BOOKING_PAYMENT', 'WITHDRAWAL')`);
        await queryRunner.query(`CREATE TYPE "public"."wallet_holds_status_enum" AS ENUM('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "wallet_holds" ("id" uuid NOT NULL, "wallet_id" uuid NOT NULL, "amount" bigint NOT NULL, "hold_type" "public"."wallet_holds_hold_type_enum" NOT NULL, "status" "public"."wallet_holds_status_enum" NOT NULL DEFAULT 'ACTIVE', "reference_type" character varying(50) NOT NULL, "reference_id" character varying(255) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE, "released_at" TIMESTAMP WITH TIME ZONE, "consumed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_232cda902424f88fb3f43fd820" CHECK ("amount" > 0), CONSTRAINT "PK_6bd7e619335cd458ee0029f939a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_wallet_holds_reference" ON "wallet_holds"  ("reference_type", "reference_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_wallet_holds_wallet_id" ON "wallet_holds"  ("wallet_id") `);
        await queryRunner.query(`CREATE TABLE "wallet_hold_allocations" ("id" uuid NOT NULL, "hold_id" uuid NOT NULL, "point_lot_id" uuid NOT NULL, "amount" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_07affe91fa1382b1372694d954" CHECK ("amount" > 0), CONSTRAINT "PK_e6da21c18dff35e524dc35f7ef1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."wallet_transactions_transaction_type_enum" AS ENUM('POINT_PURCHASE', 'PROMOTIONAL_CREDIT', 'DRIVER_EARNING', 'BOOKING_PAYMENT', 'ASSURED_DEPOSIT_HOLD', 'HOLD_RELEASE', 'HOLD_CONSUMED', 'REFUND', 'NO_SHOW_FORFEITURE', 'WITHDRAWAL', 'WITHDRAWAL_REVERSAL', 'ADMIN_ADJUSTMENT')`);
        await queryRunner.query(`CREATE TYPE "public"."wallet_transactions_point_source_enum" AS ENUM('PURCHASED', 'PROMOTIONAL', 'DRIVER_EARNED')`);
        await queryRunner.query(`CREATE TYPE "public"."wallet_transactions_direction_enum" AS ENUM('CREDIT', 'DEBIT')`);
        await queryRunner.query(`CREATE TYPE "public"."wallet_transactions_status_enum" AS ENUM('POSTED', 'REVERSED')`);
        await queryRunner.query(`CREATE TABLE "wallet_transactions" ("id" uuid NOT NULL, "wallet_id" uuid NOT NULL, "user_id" uuid NOT NULL, "transaction_type" "public"."wallet_transactions_transaction_type_enum" NOT NULL, "point_source" "public"."wallet_transactions_point_source_enum", "direction" "public"."wallet_transactions_direction_enum" NOT NULL, "amount" bigint NOT NULL, "balance_before" bigint NOT NULL, "balance_after" bigint NOT NULL, "reference_type" character varying(50), "reference_id" character varying(255), "parent_transaction_id" uuid, "idempotency_key" character varying(255) NOT NULL, "status" "public"."wallet_transactions_status_enum" NOT NULL DEFAULT 'POSTED', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_e2bcef0b14414a6ca1baca8d52" CHECK ("balance_after" >= 0), CONSTRAINT "CHK_10918bc4880a1c0e623b103f49" CHECK ("balance_before" >= 0), CONSTRAINT "CHK_fa5614af411854e069541a66f4" CHECK ("amount" > 0), CONSTRAINT "PK_5120f131bde2cda940ec1a621db" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_wallet_transactions_idempotency_key" ON "wallet_transactions"  ("idempotency_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_wallet_transactions_reference" ON "wallet_transactions"  ("reference_type", "reference_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_wallet_transactions_wallet_id" ON "wallet_transactions"  ("wallet_id") `);
        await queryRunner.query(`ALTER TABLE "wallet_point_lots" ADD CONSTRAINT "FK_f0dbae32ad0b0def06d04ecd8bf" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wallet_balances" ADD CONSTRAINT "FK_df71d0f9058318ebc25302aa365" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wallet_holds" ADD CONSTRAINT "FK_2ea4d3537181d3b2cc910dc18c0" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wallet_hold_allocations" ADD CONSTRAINT "FK_118a0f524b56a1d30dc115b5a8e" FOREIGN KEY ("hold_id") REFERENCES "wallet_holds"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wallet_hold_allocations" ADD CONSTRAINT "FK_d2607258ff06a827e971d1198a1" FOREIGN KEY ("point_lot_id") REFERENCES "wallet_point_lots"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wallet_transactions" ADD CONSTRAINT "FK_c57d19129968160f4db28fc8b28" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wallet_transactions" ADD CONSTRAINT "FK_4796762c619893704abbc3dce65" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "wallet_transactions" DROP CONSTRAINT "FK_4796762c619893704abbc3dce65"`);
        await queryRunner.query(`ALTER TABLE "wallet_transactions" DROP CONSTRAINT "FK_c57d19129968160f4db28fc8b28"`);
        await queryRunner.query(`ALTER TABLE "wallet_hold_allocations" DROP CONSTRAINT "FK_d2607258ff06a827e971d1198a1"`);
        await queryRunner.query(`ALTER TABLE "wallet_hold_allocations" DROP CONSTRAINT "FK_118a0f524b56a1d30dc115b5a8e"`);
        await queryRunner.query(`ALTER TABLE "wallet_holds" DROP CONSTRAINT "FK_2ea4d3537181d3b2cc910dc18c0"`);
        await queryRunner.query(`ALTER TABLE "wallet_balances" DROP CONSTRAINT "FK_df71d0f9058318ebc25302aa365"`);
        await queryRunner.query(`ALTER TABLE "wallet_point_lots" DROP CONSTRAINT "FK_f0dbae32ad0b0def06d04ecd8bf"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_wallet_transactions_wallet_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_wallet_transactions_reference"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_wallet_transactions_idempotency_key"`);
        await queryRunner.query(`DROP TABLE "wallet_transactions"`);
        await queryRunner.query(`DROP TYPE "public"."wallet_transactions_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."wallet_transactions_direction_enum"`);
        await queryRunner.query(`DROP TYPE "public"."wallet_transactions_point_source_enum"`);
        await queryRunner.query(`DROP TYPE "public"."wallet_transactions_transaction_type_enum"`);
        await queryRunner.query(`DROP TABLE "wallet_hold_allocations"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_wallet_holds_wallet_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_wallet_holds_reference"`);
        await queryRunner.query(`DROP TABLE "wallet_holds"`);
        await queryRunner.query(`DROP TYPE "public"."wallet_holds_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."wallet_holds_hold_type_enum"`);
        await queryRunner.query(`DROP TABLE "wallet_balances"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_wallet_point_lots_wallet_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_wallet_point_lots_expires_at"`);
        await queryRunner.query(`DROP TABLE "wallet_point_lots"`);
        await queryRunner.query(`DROP TYPE "public"."wallet_point_lots_source_type_enum"`);
    }

}
