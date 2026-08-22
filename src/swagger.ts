import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { VerificationTypeSchema } from './verification/dto/verification-type.schema';

export const SWAGGER_PATH = 'api/docs';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('BhaiWay Backend API')
    .setDescription('BhaiWay Carpooling Platform Backend API')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Paste a BhaiWay JWT access token (from /auth/msg91/verify or /auth/dev/login).',
      },
      'bearer',
    )
    .addTag('Auth', 'Authentication endpoints (MSG91 + development login)')
    .addTag('Users', 'Authenticated user and profile endpoints')
    .addTag('Verification', 'Identity, driving license, and vehicle verification')
    .addTag('Vehicles', 'User vehicle management')
    .addTag('Rides', 'Driver ride publishing and passenger ride search')
    .addTag(
      'Bookings',
      'Passenger seat reservations (Phase 1 — no wallet movement)',
    )
    .addTag(
      'Tracking',
      'Regular ride live driver location (Redis current fix; JWT + ownership)',
    )
    .addTag(
      'Wallet',
      'Wallet financial operations (service layer only — no HTTP endpoints yet)',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [VerificationTypeSchema],
  });
  SwaggerModule.setup(SWAGGER_PATH, app, document);
}
