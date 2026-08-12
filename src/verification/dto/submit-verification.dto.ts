import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Safe document metadata only. Never accept identity numbers, DL numbers,
 * status, verifiedAt, provider, or userId from the client.
 */
export class SubmitVerificationDto {
  @ApiPropertyOptional({
    description: 'Object-storage URL reference (not document contents)',
    maxLength: 2048,
    example: 'https://cdn.example.com/docs/id.pdf',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  documentUrl?: string;

  @ApiPropertyOptional({
    description: 'Logical document type label',
    maxLength: 50,
    example: 'IDENTITY_SCAN',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  documentType?: string;

  @ApiPropertyOptional({
    description: 'Object-storage object key / reference id',
    maxLength: 255,
    example: 'obj-id-1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  documentReference?: string;
}
