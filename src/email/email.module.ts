import { Module } from '@nestjs/common';

import { SmtpMailService } from './smtp-mail.service';

@Module({
  providers: [SmtpMailService],
  exports: [SmtpMailService],
})
export class EmailModule {}
