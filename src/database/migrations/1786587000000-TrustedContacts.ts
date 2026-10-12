import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Safety Hub — Trusted Contacts (soft-deletable, owner-scoped).
 */
export class TrustedContacts1786587000000 implements MigrationInterface {
  name = 'TrustedContacts1786587000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "trusted_contacts" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "name" character varying(100) NOT NULL,
        "phone_number" character varying(20) NOT NULL,
        "relationship" character varying(32) NOT NULL,
        "photo_url" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_trusted_contacts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_trusted_contacts_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_trusted_contacts_user_id"
      ON "trusted_contacts" ("user_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_trusted_contacts_user_phone_active"
      ON "trusted_contacts" ("user_id", "phone_number")
      WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_trusted_contacts_user_phone_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_trusted_contacts_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "trusted_contacts"`);
  }
}
