import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { PAYMENT_GATEWAY, PaymentGatewayPort } from './payment-gateway.port';
import { MockPaymentGateway } from './mock-payment.gateway';
import { RazorpayPaymentGateway } from './razorpay-payment.gateway';

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
        const provider = configService
          .get<string>('PAYMENT_GATEWAY_PROVIDER', 'mock')
          ?.trim()
          .toLowerCase();

        if (provider === 'mock') {
          return mockGateway;
        }

        if (provider === 'razorpay') {
          return new RazorpayPaymentGateway(configService);
        }

        throw new Error(`Unsupported PAYMENT_GATEWAY_PROVIDER: ${provider}`);
      },
    },
  ],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentGatewayModule {}
