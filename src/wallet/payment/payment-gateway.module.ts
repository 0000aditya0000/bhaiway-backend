import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { PAYMENT_GATEWAY, PaymentGatewayPort } from './payment-gateway.port';
import { MockPaymentGateway } from './mock-payment.gateway';

@Module({
  imports: [ConfigModule],
  providers: [
    MockPaymentGateway,
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService, MockPaymentGateway],
      useFactory: (
        configService: ConfigService,
        mockGateway: MockPaymentGateway,
      ): PaymentGatewayPort => {
        const provider = configService.get<string>(
          'PAYMENT_GATEWAY_PROVIDER',
          'mock',
        );

        if (provider === 'mock') {
          return mockGateway;
        }

        throw new Error(`Unsupported PAYMENT_GATEWAY_PROVIDER: ${provider}`);
      },
    },
  ],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentGatewayModule {}
