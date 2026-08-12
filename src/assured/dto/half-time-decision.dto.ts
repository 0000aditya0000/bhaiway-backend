import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { RegularSeatsPolicy } from '../../rides/enums/ride.enums';

export class HalfTimeDecisionDto {
  @ApiProperty({
    enum: RegularSeatsPolicy,
    enumName: 'RegularSeatsPolicy',
    description:
      'KEEP_ASSURED_ONLY (default effective policy) or ALLOW_REGULAR_RIDERS for remaining seats after half-time',
  })
  @IsEnum(RegularSeatsPolicy)
  policy!: RegularSeatsPolicy;
}
