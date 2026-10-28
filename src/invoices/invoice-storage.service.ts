import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import {
  INVOICE_LOGO_MAX_BYTES,
  INVOICE_LOGO_MIME,
  INVOICE_STORAGE_SUBDIR,
} from './invoice.constants';

@Injectable()
export class InvoiceStorageService {
  private readonly logger = new Logger(InvoiceStorageService.name);
  private readonly rootDir: string;

  constructor(private readonly configService: ConfigService) {
    const configured = this.configService.get<string>('INVOICE_STORAGE_DIR');
    this.rootDir = configured?.trim()
      ? path.resolve(configured.trim())
      : path.resolve(process.cwd(), 'storage', INVOICE_STORAGE_SUBDIR);
  }

  getRootDir(): string {
    return this.rootDir;
  }

  async savePdf(invoiceId: string, buffer: Buffer): Promise<{
    storageKey: string;
    sha256: string;
  }> {
    const year = new Date().getUTCFullYear().toString();
    const storageKey = `pdf/${year}/${invoiceId}.pdf`;
    await this.writeAtomic(storageKey, buffer);
    return { storageKey, sha256: sha256Hex(buffer) };
  }

  async readPdf(storageKey: string): Promise<Buffer> {
    this.assertSafeKey(storageKey);
    return fs.readFile(this.absolutePath(storageKey));
  }

  async pdfExists(storageKey: string): Promise<boolean> {
    try {
      this.assertSafeKey(storageKey);
      await fs.access(this.absolutePath(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  async saveLogo(buffer: Buffer, mimeType: string): Promise<string> {
    if (buffer.length === 0 || buffer.length > INVOICE_LOGO_MAX_BYTES) {
      throw new Error('Invoice logo must be between 1 byte and 1 MB');
    }
    if (!INVOICE_LOGO_MIME.includes(mimeType as (typeof INVOICE_LOGO_MIME)[number])) {
      throw new Error('Invoice logo must be PNG, JPEG, or WebP');
    }
    const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
    const storageKey = `logo/${randomUUID()}.${ext}`;
    await this.writeAtomic(storageKey, buffer);
    return storageKey;
  }

  async readOptionalFile(storageKey: string | null): Promise<Buffer | null> {
    if (!storageKey) {
      return null;
    }
    try {
      this.assertSafeKey(storageKey);
      return await fs.readFile(this.absolutePath(storageKey));
    } catch (error) {
      this.logger.warn(
        `Invoice file missing key=${storageKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async writeAtomic(storageKey: string, buffer: Buffer): Promise<void> {
    this.assertSafeKey(storageKey);
    const dest = this.absolutePath(storageKey);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, dest);
  }

  private absolutePath(storageKey: string): string {
    return path.join(this.rootDir, storageKey);
  }

  private assertSafeKey(storageKey: string): void {
    if (
      !storageKey ||
      storageKey.includes('..') ||
      path.isAbsolute(storageKey) ||
      storageKey.includes('\\')
    ) {
      throw new Error('Invalid invoice storage key');
    }
  }
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
