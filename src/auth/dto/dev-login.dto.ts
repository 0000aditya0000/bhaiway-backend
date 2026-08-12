import { ApiPropertyOptional } from '@nestjs/swagger';

export class DevLoginDto {
  /**
   * Optional. Ignored for authentication — DEV_AUTH_PHONE from config is used.
   * Present only for client compatibility / documentation of the configured phone.
   */
  @ApiPropertyOptional({
    description:
      'Ignored by the server. Authentication always uses DEV_AUTH_PHONE from server configuration. DEVELOPMENT ONLY.',
    example: '+919876543210',
  })
  phone?: string;
}
