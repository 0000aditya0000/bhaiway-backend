import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { SUPPORT_COMMENT_MAX } from '../enums/support.enums';

export class AddSupportCommentDto {
  @ApiProperty({ minLength: 1, maxLength: SUPPORT_COMMENT_MAX })
  @Transform(({ value }): string =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(SUPPORT_COMMENT_MAX)
  message!: string;

  @ApiPropertyOptional({
    description: 'Client idempotency key to prevent duplicate comments',
  })
  @IsOptional()
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;
}
