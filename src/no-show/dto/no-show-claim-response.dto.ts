import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideType } from '../../rides/enums/ride.enums';
import {
  NoShowClaimEffectKind,
  NoShowClaimEffectStatus,
  NoShowClaimKind,
  NoShowClaimStatus,
  NoShowDecisionSource,
} from '../enums/no-show.enums';

export class NoShowSupportHintDto {
  @ApiProperty({
    description:
      'Open Help & Support with this category after a rejected No-Show claim.',
    example: 'BOOKINGS_AND_RIDES',
  })
  category!: string;

  @ApiProperty({ example: 'OTHER' })
  subcategory!: string;

  @ApiProperty({
    description: 'Short instruction for the claimant.',
  })
  message!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  ticketId!: string | null;
}

export class NoShowClaimEffectDto {
  @ApiProperty({ enum: NoShowClaimEffectKind, enumName: 'NoShowClaimEffectKind' })
  kind!: NoShowClaimEffectKind;

  @ApiProperty({
    enum: NoShowClaimEffectStatus,
    enumName: 'NoShowClaimEffectStatus',
  })
  status!: NoShowClaimEffectStatus;

  @ApiProperty()
  attemptCount!: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  nextAttemptAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastError!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;
}

export class NoShowClaimResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  bookingId!: string | null;

  @ApiProperty({ enum: RideType, enumName: 'RideType' })
  rideType!: RideType;

  @ApiProperty({ enum: NoShowClaimKind, enumName: 'NoShowClaimKind' })
  kind!: NoShowClaimKind;

  @ApiProperty({ format: 'uuid' })
  claimantUserId!: string;

  @ApiProperty({ format: 'uuid' })
  respondentUserId!: string;

  @ApiProperty({ enum: NoShowClaimStatus, enumName: 'NoShowClaimStatus' })
  status!: NoShowClaimStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  respondBy!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  respondedAt!: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  respondedByUserId!: string | null;

  @ApiPropertyOptional({
    enum: NoShowDecisionSource,
    enumName: 'NoShowDecisionSource',
    nullable: true,
  })
  decisionSource!: NoShowDecisionSource | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  settledAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  settlementIdempotencyKey!: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  supportTicketId!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({
    description:
      'True when this request reused an already-open pending claim (duplicate report).',
  })
  alreadyOpen!: boolean;

  @ApiPropertyOptional({ type: NoShowSupportHintDto, nullable: true })
  support!: NoShowSupportHintDto | null;

  @ApiPropertyOptional({
    type: [NoShowClaimEffectDto],
    description:
      'Post-commit effect outbox (notifications / support ticket). Pending or failed rows are retried without reopening the claim.',
  })
  effects!: NoShowClaimEffectDto[];
}
