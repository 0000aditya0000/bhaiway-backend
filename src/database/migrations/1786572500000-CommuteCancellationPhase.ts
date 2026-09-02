import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommuteCancellationPhase1786572500000 implements MigrationInterface {
  name = 'CommuteCancellationPhase1786572500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."bookings_cancellation_reason_enum"
      ADD VALUE IF NOT EXISTS 'COMMUTE_RIDE_FULL'
    `);

    await queryRunner.query(`
      ALTER TYPE "public"."bookings_payment_status_enum"
      ADD VALUE IF NOT EXISTS 'REFUNDED'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL enum values cannot be removed safely; forward-only migration.
  }
}
