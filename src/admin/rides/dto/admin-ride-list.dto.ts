import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { RideStatus, RideType } from '../../../rides/enums/ride.enums';

export class AdminRideListQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Search ride UUID, driver/passenger UUID, name, or phone',
  })
  @IsOptional()
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: RideStatus })
  @IsOptional()
  @IsEnum(RideStatus)
  status?: RideStatus;

  @ApiPropertyOptional({ enum: RideType })
  @IsOptional()
  @IsEnum(RideType)
  rideType?: RideType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  passengerId?: string;

  @ApiPropertyOptional({ description: 'Departure date from (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  departureFrom?: string;

  @ApiPropertyOptional({ description: 'Departure date to (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  departureTo?: string;

  @ApiPropertyOptional({ description: 'Created-at from (ISO-8601)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  createdFrom?: string;

  @ApiPropertyOptional({ description: 'Created-at to (ISO-8601)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  createdTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(255)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(255)
  destination?: string;
}

export class AdminRideDriverSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  phoneMasked!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePhoto!: string | null;
}

export class AdminRideListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RideType })
  rideType!: RideType;

  @ApiProperty({ enum: RideStatus })
  status!: RideStatus;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty()
  departureDate!: string;

  @ApiProperty()
  departureTime!: string;

  @ApiProperty()
  totalSeats!: number;

  @ApiProperty()
  availableSeats!: number;

  @ApiProperty({
    description: 'Reserved seats. Commute PENDING requests are excluded.',
  })
  bookedSeats!: number;

  @ApiProperty({ example: '250' })
  pricePerSeat!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  cancelledAt!: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty({ type: AdminRideDriverSummaryDto })
  driver!: AdminRideDriverSummaryDto;
}

export class AdminRideListResponseDto {
  @ApiProperty({ type: AdminRideListItemDto, isArray: true })
  items!: AdminRideListItemDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;
}
