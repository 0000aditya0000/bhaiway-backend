import { Global, Module } from '@nestjs/common';

import { AuditLogger } from './audit-logger';

@Global()
@Module({
  providers: [AuditLogger],
  exports: [AuditLogger],
})
export class LoggingModule {}
