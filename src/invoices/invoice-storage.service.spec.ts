import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { InvoiceStorageService } from './invoice-storage.service';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('InvoiceStorageService.saveLogo', () => {
  let service: InvoiceStorageService;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'bhaiway-logo-'));
    service = new InvoiceStorageService({
      get: () => dir,
    } as unknown as ConfigService);
  });

  it('stores a PNG even when the declared mime is octet-stream', async () => {
    const key = await service.saveLogo(PNG_1X1, 'application/octet-stream');
    expect(key).toMatch(/^logo\/.+\.png$/);
    expect(readFileSync(path.join(dir, key)).equals(PNG_1X1)).toBe(true);
  });

  it('rejects a non-image with BadRequestException instead of an untyped Error', async () => {
    await expect(
      service.saveLogo(Buffer.from('not-an-image'), 'image/gif'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
