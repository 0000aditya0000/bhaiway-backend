import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChatService } from './chat.service';
import {
  ChatConversationDto,
  ChatConversationListDto,
  ChatMessageAckDto,
  ChatMessagesPageDto,
  ChatMessagesQueryDto,
  ChatReadResultDto,
  MarkChatReadDto,
  SendChatMessageDto,
} from './dto/chat.dto';

@ApiTags('chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('conversations')
  @ApiOperation({
    summary: 'List chat conversations for the authenticated user',
    description:
      'Returns driver↔passenger conversations for bookings the user participates in. ' +
      'Includes otherParticipant, lastMessage, unreadCount, and OPEN/CLOSED status.',
  })
  @ApiOkResponse({ type: ChatConversationListDto })
  listConversations(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.chatService.listConversations(currentUser.userId);
  }

  @Get('conversations/:conversationId')
  @ApiOperation({ summary: 'Get one conversation metadata' })
  @ApiOkResponse({ type: ChatConversationDto })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  getConversation(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.chatService.getConversation(
      currentUser.userId,
      conversationId,
    );
  }

  @Get('conversations/:conversationId/messages')
  @ApiOperation({
    summary: 'List messages (cursor pagination)',
    description:
      'Newest first. Pass before=<messageId> to load older messages. Closed chats remain readable.',
  })
  @ApiOkResponse({ type: ChatMessagesPageDto })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  listMessages(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: ChatMessagesQueryDto,
  ) {
    return this.chatService.listMessages(
      currentUser.userId,
      conversationId,
      query,
    );
  }

  @Post('conversations/:conversationId/messages')
  @ApiOperation({
    summary: 'Send a text message (REST fallback)',
    description:
      'Preferred realtime path is WebSocket chat:send. Sender is always the JWT subject. ' +
      'clientMessageId is idempotent per sender.',
  })
  @ApiOkResponse({ type: ChatMessageAckDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse({ description: 'CHAT_CLOSED' })
  @ApiForbiddenResponse()
  @ApiNotFoundResponse()
  sendMessage(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: SendChatMessageDto,
  ) {
    return this.chatService.sendMessage(currentUser.userId, conversationId, body);
  }

  @Post('conversations/:conversationId/read')
  @ApiOperation({
    summary: 'Mark inbound messages as read',
    description:
      'Marks unread messages from the other participant. Own messages are never marked.',
  })
  @ApiOkResponse({ type: ChatReadResultDto })
  @ApiForbiddenResponse()
  @ApiNotFoundResponse()
  markRead(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: MarkChatReadDto,
  ) {
    return this.chatService.markRead(
      currentUser.userId,
      conversationId,
      body.upToMessageId,
    );
  }
}
