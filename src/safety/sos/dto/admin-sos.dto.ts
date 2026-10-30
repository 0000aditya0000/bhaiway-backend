import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import {
  SafetyIncidentSeverity,
  SafetyIncidentStatus,
  SafetyIncidentType,
  SosSeverity,
  SosStatus,
} from '../enums/sos.enums';
import { RideType } from '../../../rides/enums/ride.enums';

export class AdminSosListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(SosStatus)
  status?: SosStatus;

  @IsOptional()
  @IsEnum(SosSeverity)
  severity?: SosSeverity;

  @IsOptional()
  @IsEnum(RideType)
  rideType?: RideType;

  @IsOptional()
  @IsUUID()
  rideId?: string;

  @IsOptional()
  @IsUUID()
  triggerUserId?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class AdminSosReasonDto {
  @ApiPropertyOptional()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class AdminSosNoteDto {
  @IsString()
  @Length(1, 2000)
  body!: string;
}

export class AdminIncidentListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(SafetyIncidentStatus)
  status?: SafetyIncidentStatus;

  @IsOptional()
  @IsEnum(SafetyIncidentSeverity)
  severity?: SafetyIncidentSeverity;

  @IsOptional()
  @IsEnum(SafetyIncidentType)
  type?: SafetyIncidentType;
}
