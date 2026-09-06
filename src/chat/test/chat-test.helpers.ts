import { DataSource, In } from 'typeorm';

import { ChatConversation } from '../entities/chat-conversation.entity';
import { ChatMessage } from '../entities/chat-message.entity';

/**
 * Deletes chat rows for the given bookings so test teardown can remove bookings
 * under ON DELETE RESTRICT FKs.
 */
export async function deleteChatForBookingIds(
  dataSource: DataSource,
  bookingIds: string[],
): Promise<void> {
  if (bookingIds.length === 0) {
    return;
  }

  const conversations = await dataSource.getRepository(ChatConversation).find({
    where: { bookingId: In(bookingIds) },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  if (conversationIds.length === 0) {
    return;
  }

  await dataSource
    .getRepository(ChatMessage)
    .createQueryBuilder()
    .delete()
    .where('conversation_id IN (:...ids)', { ids: conversationIds })
    .execute();

  await dataSource
    .getRepository(ChatConversation)
    .createQueryBuilder()
    .delete()
    .where('id IN (:...ids)', { ids: conversationIds })
    .execute();
}
