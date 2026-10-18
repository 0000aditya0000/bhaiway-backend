import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for in-app notification center listing and unread counts.
 * read_at already exists on notifications (NotificationFoundation).
 */
export class NotificationInboxIndexes1786592000000
  implements MigrationInterface
{
  name = 'NotificationInboxIndexes1786592000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_recipient_created_at"
      ON "notifications" ("recipient_user_id", "created_at" DESC, "id" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_recipient_unread"
      ON "notifications" ("recipient_user_id", "created_at" DESC)
      WHERE "read_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_notifications_recipient_unread"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_notifications_recipient_created_at"`,
    );
  }
}
