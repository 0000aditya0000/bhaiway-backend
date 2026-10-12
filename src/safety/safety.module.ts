import { Module } from '@nestjs/common';

import { TrustedContactsModule } from './trusted-contacts/trusted-contacts.module';

@Module({
  imports: [TrustedContactsModule],
  exports: [TrustedContactsModule],
})
export class SafetyModule {}
