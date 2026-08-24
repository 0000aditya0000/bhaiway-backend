import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideStatus } from '../../rides/enums/ride.enums';

export class DriverCoordinateDto {
  @ApiProperty({ example: 28.6139 })
  latitude!: number;

  @ApiProperty({ example: 77.209 })
  longitude!: number;

  @ApiProperty({
    format: 'date-time',
    description: 'GPS fix / last update time',
  })
  timestamp!: string;

  @ApiPropertyOptional({
    description: 'Compass heading in degrees when provided by the driver',
    example: 125,
  })
  heading?: number;

  @ApiPropertyOptional({
    description: 'Speed when provided by the driver',
    example: 32,
  })
  speed?: number;
}

/**
 * Mobile `useGetRideTrackingQuery` expects `driverCoordinate`.
 * Do not rename without coordinating with the app.
 */
export class RideTrackingResponseDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: RideStatus, enumName: 'RideStatus' })
  rideStatus!: RideStatus;

  @ApiPropertyOptional({
    type: DriverCoordinateDto,
    nullable: true,
    description:
      'Latest driver GPS. Null when no location has been published yet or TTL expired.',
  })
  driverCoordinate!: DriverCoordinateDto | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'Server time when the location was last stored',
  })
  updatedAt!: string | null;

  @ApiProperty({
    description:
      'True when no location exists, TTL expired, or last update is older than the freshness window',
  })
  isStale!: boolean;
}

/** Payload broadcast on `ride:location:updated` (Socket.IO). */
export class RideLocationUpdatedEventDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ type: DriverCoordinateDto })
  driverCoordinate!: DriverCoordinateDto;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

/** Payload broadcast on `ride:tracking:ended`. */
export class RideTrackingEndedEventDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiPropertyOptional({
    description: 'Why tracking stopped (complete, cancel, or clear)',
  })
  reason?: string;
}
