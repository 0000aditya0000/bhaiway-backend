import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  RideStatus,
  RideType,
  SeriesScope,
} from '../../../rides/enums/ride.enums';

export class AdminCancelRideDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    enum: SeriesScope,
    description: 'Commute series only. Default THIS_OCCURRENCE.',
  })
  @IsOptional()
  @IsEnum(SeriesScope)
  seriesScope?: SeriesScope;
}

export class AdminCancelBookingOutcomeDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ format: 'uuid' })
  passengerId!: string;

  @ApiProperty()
  previousStatus!: string;

  @ApiProperty()
  finalStatus!: string;

  @ApiProperty()
  paymentMethod!: string;

  @ApiProperty()
  paymentStatus!: string;

  @ApiProperty()
  collectedAmount!: string;

  @ApiPropertyOptional({ nullable: true })
  pickupStatus!: string | null;

  @ApiProperty()
  boarded!: boolean;

  @ApiProperty()
  refundAmount!: string;

  @ApiProperty()
  compensationAmount!: string;

  @ApiProperty()
  depositReleasedAmount!: string;

  @ApiProperty()
  supportEscalationRequired!: boolean;
}

export class AdminCancelOccurrenceResultDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: RideType })
  rideType!: RideType | string;

  @ApiProperty()
  previousStatus!: string;

  @ApiProperty()
  finalStatus!: string;

  @ApiProperty()
  cancellationReason!: string;

  @ApiProperty({ format: 'uuid' })
  adminUserId!: string;

  @ApiProperty({ format: 'date-time' })
  cancelledAt!: string;

  @ApiPropertyOptional({ enum: SeriesScope, nullable: true })
  seriesScope!: SeriesScope | string | null;

  @ApiProperty({ type: AdminCancelBookingOutcomeDto, isArray: true })
  bookings!: AdminCancelBookingOutcomeDto[];

  @ApiProperty()
  refundTotal!: string;

  @ApiProperty()
  depositReleaseTotal!: string;

  @ApiProperty()
  compensationTotal!: string;

  @ApiProperty()
  supportEscalationRequired!: boolean;

  @ApiProperty()
  alreadyApplied!: boolean;

  @ApiProperty({ isArray: true, type: String })
  financialTransactionIds!: string[];
}

export class AdminCancelRideResponseDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: RideStatus })
  previousStatus!: RideStatus | string;

  @ApiProperty({ enum: RideStatus })
  finalStatus!: RideStatus | string;

  @ApiProperty()
  cancellationReason!: string;

  @ApiProperty({ format: 'uuid' })
  adminUserId!: string;

  @ApiProperty({ format: 'date-time' })
  cancelledAt!: string;

  @ApiPropertyOptional({ enum: SeriesScope, nullable: true })
  seriesScope!: SeriesScope | string | null;

  @ApiProperty({ type: AdminCancelBookingOutcomeDto, isArray: true })
  bookings!: AdminCancelBookingOutcomeDto[];

  @ApiProperty()
  refundTotal!: string;

  @ApiProperty()
  depositReleaseTotal!: string;

  @ApiProperty()
  compensationTotal!: string;

  @ApiProperty()
  supportEscalationRequired!: boolean;

  @ApiProperty()
  alreadyApplied!: boolean;

  @ApiProperty({
    type: AdminCancelOccurrenceResultDto,
    isArray: true,
    description: 'One result per processed occurrence (series cancellations).',
  })
  occurrences!: AdminCancelOccurrenceResultDto[];
}
