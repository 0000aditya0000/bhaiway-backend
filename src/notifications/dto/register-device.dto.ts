import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { NotificationPlatform } from '../enums/notification.enums';

export class RegisterNotificationDeviceDto {
  @ApiProperty({
    description: 'FCM registration token for this device',
    minLength: 10,
    maxLength: 512,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  token!: string;

  @ApiProperty({ enum: NotificationPlatform, enumName: 'NotificationPlatform' })
  @IsEnum(NotificationPlatform)
  platform!: NotificationPlatform;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceId?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  appVersion?: string;
}

export class NotificationDeviceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: NotificationPlatform, enumName: 'NotificationPlatform' })
  platform!: NotificationPlatform;

  @ApiPropertyOptional({ nullable: true })
  deviceId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  appVersion!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  lastSeenAt!: string;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({
    description: 'Redacted token preview for client confirmation',
  })
  tokenPreview!: string;
}
