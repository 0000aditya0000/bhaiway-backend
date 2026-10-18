import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

import { NotificationType } from '../enums/notification.enums';
import type { NotificationDataPayload } from '../notifications.types';

export class NotificationListQueryDto {
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
    description: 'When true, return only notifications with readAt = null',
  })
  @IsOptional()
  @Transform(({ value }): boolean | undefined => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (value === true || value === 'true' || value === '1') {
      return true;
    }
    if (value === false || value === 'false' || value === '0') {
      return false;
    }
    return undefined;
  })
  @IsBoolean()
  unreadOnly?: boolean;
}

export class NotificationItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ enum: NotificationType, enumName: 'NotificationType' })
  type!: NotificationType;

  @ApiProperty({
    description: 'Structured navigation payload (string/number/boolean values)',
    type: 'object',
    additionalProperties: true,
  })
  data!: NotificationDataPayload;

  @ApiProperty({ description: 'Derived from readAt != null' })
  isRead!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  readAt!: string | null;
}

export class NotificationPageDto {
  @ApiProperty({ type: NotificationItemDto, isArray: true })
  items!: NotificationItemDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class NotificationUnreadCountDto {
  @ApiProperty({ example: 3, minimum: 0 })
  count!: number;
}

export class MarkAllNotificationsReadDto {
  @ApiProperty({
    description: 'Number of previously unread notifications marked as read',
    example: 5,
  })
  updatedCount!: number;
}
