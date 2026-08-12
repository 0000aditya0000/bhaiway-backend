import { ApiProperty } from '@nestjs/swagger';

import { VerificationType } from '../enums/verification.enums';

/**
 * Registered with Swagger so VerificationType appears in the OpenAPI schemas.
 * Not used as a request/response body.
 */
export class VerificationTypeSchema {
  @ApiProperty({
    enum: VerificationType,
    enumName: 'VerificationType',
    description: 'Supported verification categories',
  })
  verificationType!: VerificationType;
}
