import {
  SUPPORT_ALLOWED_IMAGE_EXTENSIONS,
  SUPPORT_ALLOWED_IMAGE_MIME_TYPES,
  SUPPORT_ATTACHMENT_URL_MAX,
} from './enums/support.enums';

export type ValidatedAttachment = {
  url: string;
  contentType: string;
};

function extensionOf(pathname: string): string {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot < 0) {
    return '';
  }
  return last.slice(dot).toLowerCase();
}

function mimeFromExtension(ext: string): string | null {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

/**
 * Validates client-supplied screenshot URLs.
 * No binary upload pipeline exists in this repo; HTTPS image URLs are the
 * established pattern (trusted contacts / commute reward media).
 */
export function validateSupportAttachmentUrl(
  raw: string,
): ValidatedAttachment | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: 'Attachment URL is empty' };
  }
  if (trimmed.length > SUPPORT_ATTACHMENT_URL_MAX) {
    return { error: 'Attachment URL exceeds maximum length' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'Attachment URL is not a valid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { error: 'Attachment URL must use HTTPS' };
  }

  const ext = extensionOf(parsed.pathname);
  if (!(SUPPORT_ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    return {
      error: 'Attachment must be a JPEG, PNG, or WebP image URL',
    };
  }

  const contentType = mimeFromExtension(ext);
  if (
    !contentType ||
    !(SUPPORT_ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(
      contentType,
    )
  ) {
    return { error: 'Unsupported image content type' };
  }

  return { url: trimmed, contentType };
}
