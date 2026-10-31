import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

export class RequestEmailChangeDto {
  @ApiProperty({
    example: 'new@example.com',
    description:
      'New email address to associate with the authenticated user account',
  })
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  newEmail!: string;
}
