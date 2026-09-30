import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideStatus, RideType } from '../../rides/enums/ride.enums';
import { AdminAlertSeverity, AdminAlertStatus } from '../entities/admin-alert.entity';

export class AdminDashboardPeriodDto {
  @ApiProperty({ example: 'Asia/Kolkata' })
  timezone!: string;

  @ApiProperty({ format: 'date-time' })
  start!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Exclusive end of the operational day',
  })
  end!: string;
}

export class AdminDashboardMetricsDto {
  @ApiProperty({
    description:
      'Platform revenue in points (₹1 = 1 point) credited to the platform wallet today',
    example: 1250,
  })
  revenueToday!: number;

  @ApiProperty()
  totalRidesToday!: number;

  @ApiProperty()
  activeRidesNow!: number;

  @ApiProperty()
  cancelledRidesToday!: number;

  @ApiProperty()
  completedRidesToday!: number;

  @ApiProperty()
  users!: number;

  @ApiProperty({
    description:
      'Users currently eligible to publish rides (IDENTITY + VEHICLE verified)',
  })
  drivers!: number;

  @ApiProperty()
  assuredRidesToday!: number;
}

export class AdminAttentionAlertDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  category!: string;

  @ApiProperty({ enum: AdminAlertSeverity })
  severity!: AdminAlertSeverity;

  @ApiProperty({ enum: AdminAlertStatus })
  status!: AdminAlertStatus;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty()
  source!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminAttentionDto {
  @ApiProperty()
  critical!: number;

  @ApiProperty()
  warning!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty({ type: [AdminAttentionAlertDto] })
  alerts!: AdminAttentionAlertDto[];
}

export class AdminActivityItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  eventType!: string;

  @ApiProperty()
  category!: string;

  @ApiProperty({ enum: AdminAlertSeverity })
  severity!: AdminAlertSeverity;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminDashboardSummaryResponseDto {
  @ApiProperty({ type: AdminDashboardPeriodDto })
  period!: AdminDashboardPeriodDto;

  @ApiProperty({ type: AdminDashboardMetricsDto })
  metrics!: AdminDashboardMetricsDto;

  @ApiProperty({ type: AdminAttentionDto })
  attention!: AdminAttentionDto;

  @ApiProperty({ type: [AdminActivityItemDto] })
  recentActivity!: AdminActivityItemDto[];
}

export class AdminLiveMapItemDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: RideType })
  rideType!: RideType;

  @ApiProperty({ enum: RideStatus })
  rideStatus!: RideStatus;

  @ApiProperty({ format: 'uuid' })
  driverId!: string;

  @ApiPropertyOptional({ nullable: true })
  driverDisplayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  vehicleMake!: string | null;

  @ApiPropertyOptional({ nullable: true })
  vehicleModel!: string | null;

  @ApiPropertyOptional({ nullable: true })
  vehicleRegistrationMasked!: string | null;

  @ApiPropertyOptional({ nullable: true })
  latitude!: number | null;

  @ApiPropertyOptional({ nullable: true })
  longitude!: number | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  locationUpdatedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  heading!: number | null;

  @ApiPropertyOptional({ nullable: true })
  speed!: number | null;

  @ApiProperty({
    description:
      'True only when Redis currently holds a live GPS fix for this ride',
  })
  hasLiveLocation!: boolean;

  @ApiProperty({
    description:
      'AVAILABLE = coords present. MISSING = IN_PROGRESS but no recent driver GPS in Redis (TTL 120s). TRACKING_UNAVAILABLE = Redis not ready.',
    example: 'MISSING',
  })
  locationStatus!: 'AVAILABLE' | 'MISSING' | 'TRACKING_UNAVAILABLE';

  @ApiProperty({
    description: 'SOS is not implemented in the current ride model',
    example: false,
  })
  sosActive!: boolean;
}

export class AdminLiveMapResponseDto {
  @ApiProperty()
  filter!: string;

  @ApiProperty({
    description: 'False when Redis tracking store is unavailable',
  })
  trackingAvailable!: boolean;

  @ApiProperty({ type: [AdminLiveMapItemDto] })
  items!: AdminLiveMapItemDto[];
}

export class AdminRecentActivityResponseDto {
  @ApiProperty({ type: [AdminActivityItemDto] })
  items!: AdminActivityItemDto[];

  @ApiPropertyOptional({ nullable: true })
  nextCursor!: string | null;
}
