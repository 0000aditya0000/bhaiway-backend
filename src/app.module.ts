import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AssuredModule } from './assured/assured.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { DatabaseModule } from './database/database.module';
import { RidesModule } from './rides/rides.module';
import { SettingsModule } from './settings/settings.module';
import { UsersModule } from './users/users.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { VerificationModule } from './verification/verification.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    DatabaseModule,
    AuthModule,
    UsersModule,
    WalletModule,
    SettingsModule,
    VerificationModule,
    VehiclesModule,
    AssuredModule,
    RidesModule,
    BookingsModule,
  ],
})
export class AppModule {}
