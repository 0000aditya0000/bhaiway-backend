import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  ChatConversationStatus,
  ChatMessageType,
} from '../enums/chat.enums';

export class ChatParticipantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePhoto!: string | null;
}

export class ChatMessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({ format: 'uuid' })
  clientMessageId!: string;

  @ApiProperty({ enum: ChatMessageType, enumName: 'ChatMessageType' })
  messageType!: ChatMessageType;

  @ApiProperty({ maxLength: 1000 })
  message!: string;

  @ApiProperty()
  createdAt!: string;

  @ApiPropertyOptional({ nullable: true })
  readAt!: string | null;
}

export class ChatLastMessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({ maxLength: 1000 })
  message!: string;

  @ApiProperty()
  createdAt!: string;
}

export class ChatConversationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({
    enum: ChatConversationStatus,
    enumName: 'ChatConversationStatus',
  })
  status!: ChatConversationStatus;

  @ApiProperty({ type: ChatParticipantDto })
  otherParticipant!: ChatParticipantDto;

  @ApiPropertyOptional({ type: ChatLastMessageDto, nullable: true })
  lastMessage!: ChatLastMessageDto | null;

  @ApiPropertyOptional({ nullable: true })
  lastMessageAt!: string | null;

  @ApiProperty({ description: 'Unread messages sent by the other participant' })
  unreadCount!: number;

  @ApiPropertyOptional({ nullable: true })
  closedAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class ChatConversationListDto {
  @ApiProperty({ type: ChatConversationDto, isArray: true })
  items!: ChatConversationDto[];
}

export class ChatMessagesPageDto {
  @ApiProperty({ type: ChatMessageDto, isArray: true })
  items!: ChatMessageDto[];

  @ApiProperty({
    description: 'Pass as before on the next request for older messages',
    nullable: true,
    format: 'uuid',
  })
  nextBefore!: string | null;

  @ApiProperty()
  hasMore!: boolean;
}

export class SendChatMessageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientMessageId!: string;

  @ApiProperty({ maxLength: 1000, minLength: 1 })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message!: string;

  @ApiPropertyOptional({
    enum: ChatMessageType,
    enumName: 'ChatMessageType',
    description: 'V1 accepts TEXT only. Omit or set TEXT.',
  })
  @IsOptional()
  @IsEnum(ChatMessageType)
  messageType?: ChatMessageType;
}

export class ChatMessageAckDto {
  @ApiProperty({ format: 'uuid' })
  clientMessageId!: string;

  @ApiProperty({ format: 'uuid' })
  messageId!: string;

  @ApiProperty({ enum: ['SENT', 'DUPLICATE'] })
  status!: 'SENT' | 'DUPLICATE';

  @ApiProperty({ type: ChatMessageDto })
  message!: ChatMessageDto;
}

export class MarkChatReadDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Optional cursor: mark messages created at or before this message as read',
  })
  @IsOptional()
  @IsUUID()
  upToMessageId?: string;
}

export class ChatReadResultDto {
  @ApiProperty()
  markedCount!: number;

  @ApiProperty()
  readAt!: string;
}

export class ChatMessagesQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Return messages strictly older than this message id',
  })
  @IsOptional()
  @IsUUID()
  before?: string;
}
