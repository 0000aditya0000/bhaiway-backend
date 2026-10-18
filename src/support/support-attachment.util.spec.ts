import { validateSupportAttachmentUrl } from './support-attachment.util';

describe('validateSupportAttachmentUrl', () => {
  it('accepts HTTPS jpeg/png/webp URLs', () => {
    expect(
      validateSupportAttachmentUrl('https://cdn.example.com/a/shot.jpg'),
    ).toEqual({
      url: 'https://cdn.example.com/a/shot.jpg',
      contentType: 'image/jpeg',
    });
    expect(
      validateSupportAttachmentUrl('https://cdn.example.com/a/shot.PNG'),
    ).toEqual({
      url: 'https://cdn.example.com/a/shot.PNG',
      contentType: 'image/png',
    });
    expect(
      validateSupportAttachmentUrl('https://cdn.example.com/a/shot.webp'),
    ).toEqual({
      url: 'https://cdn.example.com/a/shot.webp',
      contentType: 'image/webp',
    });
  });

  it('rejects http, non-image, and invalid URLs', () => {
    const httpResult = validateSupportAttachmentUrl(
      'http://cdn.example.com/a.jpg',
    );
    expect('error' in httpResult).toBe(true);

    const gifResult = validateSupportAttachmentUrl(
      'https://cdn.example.com/a.gif',
    );
    expect('error' in gifResult).toBe(true);

    const badResult = validateSupportAttachmentUrl('not-a-url');
    expect('error' in badResult).toBe(true);
  });
});
