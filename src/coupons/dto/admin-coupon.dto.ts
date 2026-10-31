import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import {
  CouponApplicableTo,
  CouponAudience,
  CouponBenefitType,
  CouponChargeScope,
  CouponRideTypeScope,
} from '../enums/coupon.enums';

export class CreateCouponAdminDto {
  @ApiPropertyOptional({
    description: 'Custom code; generated if omitted. Compared case-insensitively.',
  })
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  code?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: CouponBenefitType })
  @IsEnum(CouponBenefitType)
  benefitType!: CouponBenefitType;

  @ApiProperty({
    description:
      'Points for POINTS_CREDIT/FIXED_DISCOUNT, or 1–100 for PERCENTAGE_DISCOUNT',
    example: '50',
  })
  @IsString()
  benefitValue!: string;

  @ApiPropertyOptional({
    description: 'Cap for PERCENTAGE_DISCOUNT (points). Required only for percentage.',
  })
  @IsOptional()
  @IsString()
  maxDiscountAmount?: string;

  @ApiPropertyOptional({ description: 'Minimum eligible charge amount (points).' })
  @IsOptional()
  @IsString()
  minEligibleAmount?: string;

  @ApiProperty({ enum: CouponRideTypeScope })
  @IsEnum(CouponRideTypeScope)
  rideTypeScope!: CouponRideTypeScope;

  @ApiProperty({ enum: CouponChargeScope })
  @IsEnum(CouponChargeScope)
  chargeScope!: CouponChargeScope;

  @ApiProperty({ enum: CouponAudience })
  @IsEnum(CouponAudience)
  audience!: CouponAudience;

  @ApiPropertyOptional({
    enum: CouponApplicableTo,
    default: CouponApplicableTo.ALL,
    description:
      'Who may redeem this coupon: ALL, DRIVERS_ONLY, or RIDERS_ONLY. Defaults to ALL.',
  })
  @IsOptional()
  @IsEnum(CouponApplicableTo)
  applicableTo?: CouponApplicableTo;

  @ApiProperty()
  @IsDateString()
  startsAt!: string;

  @ApiProperty()
  @IsDateString()
  expiresAt!: string;

  @ApiPropertyOptional({
    description:
      'Global redemption cap (REDEEMED+RESERVED). Null/omit = unlimited. Global single-use ⇒ 1.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalRedemptionLimit?: number | null;

  @ApiPropertyOptional({
    description:
      'Per-user redemption cap. Null/omit = unlimited. Single-use-per-user ⇒ 1.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perUserRedemptionLimit?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Required when audience=USER_SPECIFIC',
    type: [String],
  })
  @ValidateIf((o: CreateCouponAdminDto) => o.audience === CouponAudience.USER_SPECIFIC)
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  userIds?: string[];
}

export class AssignCouponUsersDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  userIds!: string[];
}

export class UpdateCouponStatusDto {
  @ApiProperty()
  @IsBoolean()
  isActive!: boolean;
}

export class UpdateCouponAdminDto {
  @ApiPropertyOptional({
    enum: CouponApplicableTo,
    description:
      'When omitted, the existing applicableTo value is preserved.',
  })
  @IsOptional()
  @IsEnum(CouponApplicableTo)
  applicableTo?: CouponApplicableTo;
}

export class AdminCouponListQueryDto {
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
}
