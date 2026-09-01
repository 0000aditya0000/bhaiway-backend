import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RatingTargetRole } from '../enums/rating.enums';

export class PendingRatingRideDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ example: 'Noida' })
  source!: string;

  @ApiProperty({ example: 'Dehradun' })
  destination!: string;

  @ApiProperty({ example: '2026-09-20' })
  departureDate!: string;

  @ApiProperty({ example: '09:00' })
  departureTime!: string;
}

export class PendingRatingItemDto {
  @ApiProperty({ format: 'uuid' })
  taskId!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'User being rated (the target)',
  })
  userId!: string;

  @ApiPropertyOptional({
    description: 'Preferred display name of the rating target',
    nullable: true,
  })
  userName!: string | null;

  @ApiPropertyOptional({
    description: 'Profile photo URL of the rating target',
    nullable: true,
  })
  userPhoto!: string | null;

  @ApiProperty({
    enum: RatingTargetRole,
    enumName: 'RatingTargetRole',
    description:
      'Role of the rating target: PASSENGER when driver rates, DRIVER when passenger rates',
  })
  role!: RatingTargetRole;

  @ApiPropertyOptional()
  skippedAt!: string | null;

  @ApiProperty({ type: PendingRatingRideDto })
  ride!: PendingRatingRideDto;
}

export class PendingRatingsPageDto {
  @ApiProperty({ type: PendingRatingItemDto, isArray: true })
  items!: PendingRatingItemDto[];
}

export class SubmitRatingResponseDto {
  @ApiProperty({ format: 'uuid' })
  taskId!: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  rating!: number;

  @ApiPropertyOptional({ nullable: true })
  comment!: string | null;

  @ApiProperty()
  completedAt!: string;

  @ApiProperty({
    description: 'True when the rating was already submitted (idempotent retry)',
  })
  alreadyCompleted!: boolean;
}

export class SkipRatingResponseDto {
  @ApiProperty({ format: 'uuid' })
  taskId!: string;

  @ApiProperty({ enum: ['PENDING'] })
  status!: 'PENDING';

  @ApiPropertyOptional({ nullable: true })
  skippedAt!: string | null;
}

export class ReceivedRatingItemDto {
  @ApiProperty({ minimum: 1, maximum: 5 })
  rating!: number;

  @ApiPropertyOptional({ nullable: true })
  comment!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class UserRatingsSummaryDto {
  @ApiProperty({
    description: 'Average star rating from completed ratings (1 decimal place)',
    example: 4.8,
  })
  averageRating!: number;

  @ApiProperty({ description: 'Count of completed ratings received' })
  totalRatings!: number;

  @ApiProperty({ type: ReceivedRatingItemDto, isArray: true })
  items!: ReceivedRatingItemDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  totalPages!: number;
}
