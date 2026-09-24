import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class SmtpMailService implements OnModuleInit {
  private readonly logger = new Logger(SmtpMailService.name);
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST') ?? 'mail.kodenzolabs.in';
    const port = Number(this.configService.get<string>('SMTP_PORT') ?? 465);
    const secure =
      String(this.configService.get<string>('SMTP_SECURE') ?? 'true') === 'true';
    const user =
      this.configService.get<string>('SMTP_USER') ?? 'alerts@kodenzolabs.in';
    const pass = this.configService.get<string>('SMTP_PASSWORD') ?? '';
    const fromEmail =
      this.configService.get<string>('SMTP_FROM_EMAIL') ??
      'alerts@kodenzolabs.in';
    const fromName =
      this.configService.get<string>('SMTP_FROM_NAME') ?? 'BhaiWay';

    this.fromAddress = `${fromName} <${fromEmail}>`;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    const password = this.configService.get<string>('SMTP_PASSWORD') ?? '';
    if (!password.trim()) {
      this.logger.warn(
        'SMTP transporter not verified: SMTP_PASSWORD is not configured',
      );
      return;
    }

    try {
      await this.transporter.verify();
      this.logger.log(
        `SMTP transporter ready host=${this.configService.get('SMTP_HOST')} port=${this.configService.get('SMTP_PORT')}`,
      );
    } catch (error) {
      this.logger.warn(
        `SMTP transporter verification failed: ${(error as Error).message}`,
      );
    }
  }

  getFromAddress(): string {
    return this.fromAddress;
  }

  async sendEmail(params: SendEmailParams): Promise<void> {
    const password = this.configService.get<string>('SMTP_PASSWORD') ?? '';
    if (!password.trim()) {
      throw new Error('SMTP_PASSWORD is not configured');
    }

    await this.transporter.sendMail({
      from: this.fromAddress,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
  }
}
