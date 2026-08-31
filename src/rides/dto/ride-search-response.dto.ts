import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { VehicleType } from '../../vehicles/enums/vehicle-type.enum';
import { RideStatus, RideType } from '../enums/ride.enums';

export class RideSearchPreferencesDto {
  @ApiProperty()
  maxTwoInBackSeat!: boolean;

  @ApiProperty()
  noSmoking!: boolean;

  @ApiProperty()
  noPets!: boolean;

  @ApiProperty()
  luggageAllowed!: boolean;
}

export class RideSearchDriverDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null when the driver has no display name / profile yet',
  })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePhoto!: string | null;
}

export class RideSearchVehicleDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: VehicleType, enumName: 'VehicleType' })
  vehicleType!: VehicleType;

  @ApiProperty()
  make!: string;

  @ApiProperty()
  model!: string;

  @ApiPropertyOptional({ nullable: true })
  variant!: string | null;

  @ApiPropertyOptional({ nullable: true })
  color!: string | null;

  @ApiProperty()
  seatingCapacity!: number;
}

export class RideSearchItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RideType, enumName: 'RideType' })
  rideType!: RideType;

  @ApiProperty({
    enum: RideStatus,
    enumName: 'RideStatus',
    description:
      'Backend lifecycle status. Assured passenger search includes only ASSURANCE_ACTIVE.',
  })
  status!: RideStatus;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty({ example: '2026-08-20' })
  departureDate!: string;

  @ApiProperty({ example: '09:00:00' })
  departureTime!: string;

  @ApiProperty()
  availableSeats!: number;

  @ApiProperty()
  totalSeats!: number;

  @ApiProperty({
    description: 'Integer points per seat as string (1 point = ₹1)',
    example: '250',
  })
  pricePerSeat!: string;

  @ApiPropertyOptional({
    description:
      'COMMUTE only: passenger-facing fare per seat (driver price + 10% markup). ' +
      'Not a separate platform fee — this is the ride price riders pay. ' +
      'Null for REGULAR and ASSURED.',
    nullable: true,
    example: '110',
  })
  riderPricePerSeat?: string | null;

  @ApiProperty({ type: RideSearchPreferencesDto })
  preferences!: RideSearchPreferencesDto;

  @ApiPropertyOptional({ nullable: true })
  notes!: string | null;

  @ApiPropertyOptional({
    description:
      'Assured ride security-deposit percentage snapshot from publish. Null for Regular rides.',
    nullable: true,
    example: 5,
  })
  assuredDepositPercentage?: number | null;

  @ApiPropertyOptional({
    description:
      'Assured ride security-deposit amount in points from publish (totalSeats × pricePerSeat × percentage). Null for Regular rides. Rider booking deposit for N seats is computed separately at booking time.',
    nullable: true,
    example: '105',
  })
  assuredDepositAmount?: string | null;

  @ApiProperty({ type: RideSearchDriverDto })
  driver!: RideSearchDriverDto;

  @ApiProperty({ type: RideSearchVehicleDto })
  vehicle!: RideSearchVehicleDto;
}

export class RideSearchPageDto {
  @ApiProperty({ type: RideSearchItemDto, isArray: true })
  items!: RideSearchItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
