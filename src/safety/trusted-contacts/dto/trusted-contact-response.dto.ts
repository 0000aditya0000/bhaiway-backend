import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { TrustedContactRelationship } from '../enums/trusted-contact-relationship.enum';

export class TrustedContactResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Rahul Gangwar' })
  name!: string;

  @ApiProperty({ example: '+919876543210' })
  phoneNumber!: string;

  @ApiProperty({
    enum: TrustedContactRelationship,
    enumName: 'TrustedContactRelationship',
  })
  relationship!: TrustedContactRelationship;

  @ApiPropertyOptional({ nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class TrustedContactListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

export class TrustedContactPageDto {
  @ApiProperty({ type: TrustedContactResponseDto, isArray: true })
  items!: TrustedContactResponseDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 1 })
  total!: number;
}
