import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../../auth/auth.module';
import { TrustedContact } from './entities/trusted-contact.entity';
import { TrustedContactsController } from './trusted-contacts.controller';
import { TrustedContactsService } from './trusted-contacts.service';

@Module({
  imports: [TypeOrmModule.forFeature([TrustedContact]), AuthModule],
  controllers: [TrustedContactsController],
  providers: [TrustedContactsService],
  exports: [TrustedContactsService],
})
export class TrustedContactsModule {}
