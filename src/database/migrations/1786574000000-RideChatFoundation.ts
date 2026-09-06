import { MigrationInterface, QueryRunner } from 'typeorm';

export class RideChatFoundation1786574000000 implements MigrationInterface {
  name = 'RideChatFoundation1786574000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."chat_conversations_status_enum" AS ENUM('OPEN', 'CLOSED')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."chat_messages_message_type_enum" AS ENUM('TEXT')
    `);

    await queryRunner.query(`
      CREATE TABLE "chat_conversations" (
        "id" uuid NOT NULL,
        "ride_id" uuid NOT NULL,
        "booking_id" uuid NOT NULL,
        "driver_id" uuid NOT NULL,
        "passenger_id" uuid NOT NULL,
        "status" "public"."chat_conversations_status_enum" NOT NULL DEFAULT 'OPEN',
        "last_message_at" TIMESTAMP WITH TIME ZONE,
        "closed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_chat_conversations_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_chat_conversations_booking_id"
      ON "chat_conversations" ("booking_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_chat_conversations_ride_id"
      ON "chat_conversations" ("ride_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_chat_conversations_driver_id"
      ON "chat_conversations" ("driver_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_chat_conversations_passenger_id"
      ON "chat_conversations" ("passenger_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_chat_conversations_status"
      ON "chat_conversations" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_chat_conversations_last_message_at"
      ON "chat_conversations" ("last_message_at")
    `);

    await queryRunner.query(`
      ALTER TABLE "chat_conversations"
      ADD CONSTRAINT "FK_chat_conversations_ride_id"
      FOREIGN KEY ("ride_id") REFERENCES "rides"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_conversations"
      ADD CONSTRAINT "FK_chat_conversations_booking_id"
      FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_conversations"
      ADD CONSTRAINT "FK_chat_conversations_driver_id"
      FOREIGN KEY ("driver_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_conversations"
      ADD CONSTRAINT "FK_chat_conversations_passenger_id"
      FOREIGN KEY ("passenger_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "chat_messages" (
        "id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "sender_id" uuid NOT NULL,
        "client_message_id" uuid NOT NULL,
        "message_type" "public"."chat_messages_message_type_enum" NOT NULL DEFAULT 'TEXT',
        "message" character varying(1000) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "read_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_chat_messages_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_chat_messages_non_blank"
          CHECK (char_length(btrim("message")) > 0),
        CONSTRAINT "CHK_chat_messages_max_length"
          CHECK (char_length("message") <= 1000)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_chat_messages_conversation_created"
      ON "chat_messages" ("conversation_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_chat_messages_sender_id"
      ON "chat_messages" ("sender_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_chat_messages_sender_client_message"
      ON "chat_messages" ("sender_id", "client_message_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "chat_messages"
      ADD CONSTRAINT "FK_chat_messages_conversation_id"
      FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_messages"
      ADD CONSTRAINT "FK_chat_messages_sender_id"
      FOREIGN KEY ("sender_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP CONSTRAINT "FK_chat_messages_sender_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP CONSTRAINT "FK_chat_messages_conversation_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_chat_messages_sender_client_message"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_chat_messages_sender_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_chat_messages_conversation_created"`,
    );
    await queryRunner.query(`DROP TABLE "chat_messages"`);

    await queryRunner.query(
      `ALTER TABLE "chat_conversations" DROP CONSTRAINT "FK_chat_conversations_passenger_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_conversations" DROP CONSTRAINT "FK_chat_conversations_driver_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_conversations" DROP CONSTRAINT "FK_chat_conversations_booking_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_conversations" DROP CONSTRAINT "FK_chat_conversations_ride_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_chat_conversations_last_message_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_chat_conversations_status"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_chat_conversations_passenger_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_chat_conversations_driver_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_chat_conversations_ride_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_chat_conversations_booking_id"`,
    );
    await queryRunner.query(`DROP TABLE "chat_conversations"`);

    await queryRunner.query(
      `DROP TYPE "public"."chat_messages_message_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."chat_conversations_status_enum"`,
    );
  }
}
