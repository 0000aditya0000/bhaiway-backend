import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
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
