import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { SeriesScope } from '../enums/ride.enums';

export class CancelRideQueryDto {
  @ApiPropertyOptional({
    enum: SeriesScope,
    enumName: 'SeriesScope',
    default: SeriesScope.THIS_OCCURRENCE,
    description:
      'COMMUTE series only. THIS_OCCURRENCE cancels this ride only (existing commute cancellation, including booked seats/refunds) and does not cancel a paired return. THIS_AND_FUTURE also cancels later unbooked outbound and return occurrences on or after the selected occurrence_date in the same series. Booked future occurrences are skipped, not force-cancelled. Default THIS_OCCURRENCE.',
  })
  @IsOptional()
  @IsEnum(SeriesScope)
  seriesScope?: SeriesScope;
}
