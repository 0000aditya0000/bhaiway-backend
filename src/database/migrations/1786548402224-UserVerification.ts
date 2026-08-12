import { MigrationInterface, QueryRunner } from "typeorm";

export class UserVerification1786548402224 implements MigrationInterface {
    name = 'UserVerification1786548402224'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."user_verifications_verification_type_enum" AS ENUM('IDENTITY', 'DRIVING_LICENSE', 'VEHICLE')`);
        await queryRunner.query(`CREATE TYPE "public"."user_verifications_status_enum" AS ENUM('PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED')`);
        await queryRunner.query(`CREATE TABLE "user_verifications" ("id" uuid NOT NULL, "user_id" uuid NOT NULL, "verification_type" "public"."user_verifications_verification_type_enum" NOT NULL, "status" "public"."user_verifications_status_enum" NOT NULL DEFAULT 'PENDING', "provider" character varying(100), "provider_reference" character varying(255), "document_url" text, "document_type" character varying(50), "document_reference" character varying(255), "is_current" boolean NOT NULL DEFAULT true, "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL, "verified_at" TIMESTAMP WITH TIME ZONE, "rejected_at" TIMESTAMP WITH TIME ZONE, "rejection_reason" text, "expires_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3269a92433d028916ab342b94fb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_user_verifications_current" ON "user_verifications"  ("user_id", "verification_type") WHERE "is_current" = true`);
        await queryRunner.query(`CREATE INDEX "IDX_user_verifications_user_id" ON "user_verifications"  ("user_id") `);
        await queryRunner.query(`ALTER TABLE "user_verifications" ADD CONSTRAINT "FK_2c6a037273f1cb3e6fdd832db24" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user_verifications" DROP CONSTRAINT "FK_2c6a037273f1cb3e6fdd832db24"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_user_verifications_user_id"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_user_verifications_current"`);
        await queryRunner.query(`DROP TABLE "user_verifications"`);
        await queryRunner.query(`DROP TYPE "public"."user_verifications_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."user_verifications_verification_type_enum"`);
    }

}
