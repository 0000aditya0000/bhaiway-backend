import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { UserRatingDirection } from '../enums/rating.enums';

export class UserRatingsQueryDto {
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

  @ApiPropertyOptional({
    enum: UserRatingDirection,
    enumName: 'UserRatingDirection',
    default: UserRatingDirection.RECEIVED,
    description:
      'RECEIVED (default): ratings others left for this user. GIVEN: ratings this user submitted.',
  })
  @IsOptional()
  @IsEnum(UserRatingDirection)
  direction?: UserRatingDirection = UserRatingDirection.RECEIVED;
}
