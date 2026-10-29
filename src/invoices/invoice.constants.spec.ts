import {
  INVOICE_UNCONFIGURED_TAX_CONFIG_ID,
  detectInvoiceLogoMime,
  invoiceHasGstBreakdown,
} from './invoice.constants';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('detectInvoiceLogoMime', () => {
  it('detects PNG from magic bytes even when the declared type is octet-stream', () => {
    expect(detectInvoiceLogoMime(PNG_1X1, 'application/octet-stream')).toBe(
      'image/png',
    );
  });

  it('detects JPEG SOI markers', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectInvoiceLogoMime(jpeg, '')).toBe('image/jpeg');
  });

  it('falls back to a declared image mime when bytes are not recognized', () => {
    expect(detectInvoiceLogoMime(Buffer.from('x'), 'image/webp')).toBe(
      'image/webp',
    );
  });

  it('rejects gif bytes with a gif mime', () => {
    const gif = Buffer.from('GIF89a');
    expect(detectInvoiceLogoMime(gif, 'image/gif')).toBeNull();
  });
});

describe('invoiceHasGstBreakdown', () => {
  it('is false when the invoice was issued without a GST tax rule', () => {
    expect(
      invoiceHasGstBreakdown({
        taxConfigId: INVOICE_UNCONFIGURED_TAX_CONFIG_ID,
        taxConfigSnapshot: { fallback: true, reason: 'NO_ACTIVE_TAX_CONFIG' },
      }),
    ).toBe(false);
  });

  it('is true when a tax rule snapshot exists', () => {
    expect(
      invoiceHasGstBreakdown({
        taxConfigId: '55555555-5555-4555-8555-555555555555',
        taxConfigSnapshot: { gstRateBasisPoints: 1800 },
      }),
    ).toBe(true);
  });
});
