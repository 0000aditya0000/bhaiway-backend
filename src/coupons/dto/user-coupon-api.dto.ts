import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  CouponChargeScope,
  CouponRideTypeScope,
} from '../enums/coupon.enums';

export class ValidateCouponDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @ApiProperty({ enum: CouponRideTypeScope })
  @IsEnum(CouponRideTypeScope)
  rideType!: CouponRideTypeScope;

  @ApiProperty({ enum: CouponChargeScope })
  @IsEnum(CouponChargeScope)
  chargeScope!: CouponChargeScope;

  @ApiPropertyOptional({
    description:
      'Eligible charge amount in points (authoritative preview input from client estimate; booking uses server amounts).',
    example: '200',
  })
  @IsOptional()
  @IsString()
  amount?: string;
}

export class PreviewCouponDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @ApiProperty({ enum: CouponRideTypeScope })
  @IsEnum(CouponRideTypeScope)
  rideType!: CouponRideTypeScope;

  @ApiProperty({ enum: CouponChargeScope })
  @IsEnum(CouponChargeScope)
  chargeScope!: CouponChargeScope;

  @ApiProperty({
    description: 'Authoritative eligible amount for preview math.',
    example: '200',
  })
  @IsString()
  amount!: string;
}

export class DriverPreviewCouponDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Vehicle the driver intends to publish. Used to authorize Assured publishing.',
  })
  @IsUUID()
  vehicleId!: string;

  @ApiProperty({ minimum: 1, maximum: 8, example: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  totalSeats!: number;

  @ApiProperty({
    description: 'Integer points per seat (1 point = ₹1). Deposit is recalculated server-side.',
    minimum: 0,
    example: 500,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pricePerSeat!: number;
}

export class CouponListQueryDto {
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
  @Max(50)
  limit?: number = 20;
}
