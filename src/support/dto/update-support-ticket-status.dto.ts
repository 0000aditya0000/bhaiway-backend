import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { SupportTicketStatus } from '../enums/support.enums';

export class UpdateSupportTicketStatusDto {
  @ApiProperty({
    enum: SupportTicketStatus,
    description:
      'Target status. Allowed: CREATED→IN_PROGRESS|RESOLVED, IN_PROGRESS→RESOLVED. Reopening is not supported.',
  })
  @IsEnum(SupportTicketStatus)
  status!: SupportTicketStatus;
}
