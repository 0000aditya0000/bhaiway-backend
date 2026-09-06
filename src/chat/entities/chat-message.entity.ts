import {
  BeforeInsert,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';

import { User } from '../../users/entities/user.entity';
import { ChatMessageType } from '../enums/chat.enums';
import { ChatConversation } from './chat-conversation.entity';

@Entity('chat_messages')
@Index('IDX_chat_messages_conversation_created', ['conversationId', 'createdAt'])
@Index('IDX_chat_messages_sender_id', ['senderId'])
@Index('UQ_chat_messages_sender_client_message', ['senderId', 'clientMessageId'], {
  unique: true,
})
@Check(`char_length(btrim("message")) > 0`)
@Check(`char_length("message") <= 1000`)
export class ChatMessage {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => ChatConversation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'conversation_id' })
  conversation!: ChatConversation;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sender_id' })
  sender!: User;

  @Column({ name: 'sender_id', type: 'uuid' })
  senderId!: string;

  @Column({ name: 'client_message_id', type: 'uuid' })
  clientMessageId!: string;

  @Column({
    name: 'message_type',
    type: 'enum',
    enum: ChatMessageType,
    default: ChatMessageType.TEXT,
  })
  messageType!: ChatMessageType;

  @Column({ type: 'varchar', length: 1000 })
  message!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = randomUUID();
    }
  }
}
