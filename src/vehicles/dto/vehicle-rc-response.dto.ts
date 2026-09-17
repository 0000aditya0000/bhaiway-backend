import { ApiProperty } from '@nestjs/swagger';

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

  @ApiProperty({ type: VehicleRcVerificationDetailsDto })
  verification!: VehicleRcVerificationDetailsDto;
}
