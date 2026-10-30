import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VehicleRcFieldCheckDto {
  @ApiProperty({
    enum: ['MATCHED', 'MISMATCHED', 'NOT_AVAILABLE'],
    example: 'MATCHED',
  })
  status!: 'MATCHED' | 'MISMATCHED' | 'NOT_AVAILABLE';

  @ApiPropertyOptional({ nullable: true, example: 'UP16AB1234' })
  userValue!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'UP16AB1234' })
  rcValue!: string | null;
}

export class VehicleRcCheckSetDto {
  @ApiProperty({ type: VehicleRcFieldCheckDto })
  registrationNumber!: VehicleRcFieldCheckDto;

  @ApiProperty({ type: VehicleRcFieldCheckDto })
  vehicleName!: VehicleRcFieldCheckDto;

  @ApiProperty({ type: VehicleRcFieldCheckDto })
  make!: VehicleRcFieldCheckDto;

  @ApiProperty({ type: VehicleRcFieldCheckDto })
  model!: VehicleRcFieldCheckDto;

  @ApiProperty({ type: VehicleRcFieldCheckDto })
  colour!: VehicleRcFieldCheckDto;

  @ApiProperty({ type: VehicleRcFieldCheckDto })
  vehicleType!: VehicleRcFieldCheckDto;

  @ApiProperty({ type: VehicleRcFieldCheckDto })
  insurance!: VehicleRcFieldCheckDto;

  @ApiProperty({ type: VehicleRcFieldCheckDto })
  vehicleStatus!: VehicleRcFieldCheckDto;
}

export class VehicleRcErrorItemDto {
  @ApiProperty({ example: 'VEHICLE_DETAILS_MISMATCH' })
  code!: string;

  @ApiProperty({ example: 'vehicleName' })
  field!: string;

  @ApiProperty({ example: 'Vehicle name does not match RC records.' })
  message!: string;
}

export class VehicleRcVerificationDetailsDto {
  @ApiProperty({ example: 'a0000000-0000-0000-0000-000000000001' })
  vehicleId!: string;

  @ApiProperty({ example: 'VERIFIED' })
  status!: string;

  @ApiProperty({ example: 'UP14AB1234' })
  vehicleNumber!: string;

  @ApiProperty({ example: '2026-09-18T01:30:00.000Z' })
  verifiedAt!: string;

  @ApiProperty({ example: 'rc_a0000000_1234567890abcdef' })
  verificationId!: string;

  @ApiProperty({ required: false, example: 'MATCHED' })
  ownerMatchStatus?: string;
}

export class VehicleRcResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ format: 'uuid' })
  vehicleId!: string;

  @ApiProperty({ example: 'VERIFIED' })
  verificationStatus!: string;

  @ApiProperty({ type: VehicleRcCheckSetDto })
  checks!: VehicleRcCheckSetDto;

  @ApiProperty({ type: [VehicleRcErrorItemDto] })
  errors!: VehicleRcErrorItemDto[];

  @ApiProperty({ type: VehicleRcVerificationDetailsDto })
  verification!: VehicleRcVerificationDetailsDto;
}
