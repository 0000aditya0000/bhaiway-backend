import { Module } from '@nestjs/common';

import { SosModule } from './sos/sos.module';
import { TrustedContactsModule } from './trusted-contacts/trusted-contacts.module';

@Module({
  imports: [TrustedContactsModule, SosModule],
  exports: [TrustedContactsModule, SosModule],
})
export class SafetyModule {}
