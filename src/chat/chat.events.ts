/** Socket.IO client → server */
export const CHAT_SOCKET_EVENTS = {
  JOIN: 'chat:join',
  LEAVE: 'chat:leave',
  SEND: 'chat:send',
  READ: 'chat:read',
  TYPING: 'chat:typing',
  STOP_TYPING: 'chat:stop_typing',
} as const;

/** Socket.IO server → client */
export const CHAT_SERVER_EVENTS = {
  MESSAGE: 'chat:message',
  MESSAGE_ACK: 'chat:message_ack',
  READ: 'chat:read',
  TYPING: 'chat:typing',
  STOP_TYPING: 'chat:stop_typing',
  CONVERSATION_CLOSED: 'chat:conversation_closed',
  ERROR: 'chat:error',
} as const;

export const CHAT_SOCKET_NAMESPACE = '/chat';

export const CHAT_REDIS_CHANNEL = 'bhaiway:chat:events';

export function chatConversationRoom(conversationId: string): string {
  return `chat:conversation:${conversationId}`;
}
