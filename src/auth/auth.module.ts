import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OTP_PROVIDER } from './providers/otp-provider.interface';
import { Msg91OtpProvider } from './providers/msg91.provider';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const expiresIn = configService.get<string>(
          'JWT_ACCESS_EXPIRES_IN',
          '15m',
        );
        return {
          secret: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
          signOptions: {
            expiresIn: expiresIn as unknown as number,
          },
        };
      },
    }),
    TypeOrmModule.forFeature([User, UserProfile, Wallet, WalletBalance]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    Msg91OtpProvider,
    {
      provide: OTP_PROVIDER,
      useExisting: Msg91OtpProvider,
    },
    JwtStrategy,
    JwtAuthGuard,
  ],
  exports: [AuthService, JwtModule, PassportModule, JwtAuthGuard, JwtStrategy],
})
export class AuthModule {}
