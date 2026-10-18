import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  SupportCommentAuthorType,
  SupportRideRelationRole,
  SupportTicketCategory,
  SupportTicketStatus,
} from '../enums/support.enums';

export class SupportAttachmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  url!: string;

  @ApiProperty()
  contentType!: string;

  @ApiProperty()
  createdAt!: string;
}

export class SupportCommentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: SupportCommentAuthorType })
  authorType!: SupportCommentAuthorType;

  @ApiProperty({ format: 'uuid' })
  authorUserId!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty()
  createdAt!: string;
}

export class SupportStatusHistoryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ enum: SupportTicketStatus, nullable: true })
  fromStatus!: SupportTicketStatus | null;

  @ApiProperty({ enum: SupportTicketStatus })
  toStatus!: SupportTicketStatus;

  @ApiProperty()
  changedByAdmin!: boolean;

  @ApiProperty()
  createdAt!: string;
}

export class SupportRelatedRideSummaryDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  bookingId!: string | null;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty()
  departureDate!: string;

  @ApiProperty()
  departureTime!: string;

  @ApiProperty()
  rideStatus!: string;

  @ApiPropertyOptional({ enum: SupportRideRelationRole, nullable: true })
  role!: SupportRideRelationRole | null;
}

export class SupportTicketListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'SUP-A1B2C3D4' })
  reference!: string;

  @ApiProperty({ enum: SupportTicketCategory })
  category!: SupportTicketCategory;

  @ApiProperty()
  subcategory!: string;

  @ApiProperty()
  subject!: string;

  @ApiProperty({ enum: SupportTicketStatus })
  status!: SupportTicketStatus;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  relatedRideId!: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  relatedBookingId!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  @ApiPropertyOptional({ nullable: true })
  resolvedAt!: string | null;
}

export class SupportTicketDetailDto extends SupportTicketListItemDto {
  @ApiProperty()
  description!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  relatedWalletTransactionId!: string | null;

  @ApiProperty({ type: [SupportAttachmentDto] })
  attachments!: SupportAttachmentDto[];

  @ApiProperty({ type: [SupportCommentDto] })
  comments!: SupportCommentDto[];

  @ApiProperty({ type: [SupportStatusHistoryDto] })
  statusHistory!: SupportStatusHistoryDto[];

  @ApiPropertyOptional({ type: SupportRelatedRideSummaryDto, nullable: true })
  relatedRide!: SupportRelatedRideSummaryDto | null;
}

export class SupportTicketPageDto {
  @ApiProperty({ type: [SupportTicketListItemDto] })
  items!: SupportTicketListItemDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class EligibleSupportRideDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  bookingId!: string | null;

  @ApiProperty({ enum: SupportRideRelationRole })
  role!: SupportRideRelationRole;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty()
  departureDate!: string;

  @ApiProperty()
  departureTime!: string;

  @ApiProperty()
  rideStatus!: string;

  @ApiPropertyOptional({ nullable: true })
  bookingStatus!: string | null;

  @ApiProperty()
  rideType!: string;
}

export class EligibleSupportRidePageDto {
  @ApiProperty({ type: [EligibleSupportRideDto] })
  items!: EligibleSupportRideDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class AdminSupportTicketListItemDto extends SupportTicketListItemDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiPropertyOptional({ nullable: true })
  userName!: string | null;
}
