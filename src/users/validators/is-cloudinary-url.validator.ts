import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Validates whether a value is a valid Cloudinary HTTPS secure_url belonging to the configured cloud.
 *
 * Rules:
 * - Must be a valid HTTPS URL (rejects http://, file://, content://, etc.)
 * - Host must be `res.cloudinary.com` or `<cloud_name>.cloudinary.com`
 * - Cloud name must match the configured CLOUDINARY_CLOUD_NAME (default: 'bhaiway')
 * - Rejects non-Cloudinary domains and local device URIs
 * - Null, undefined, or empty string values are considered valid (field is optional)
 */
export function isCloudinaryUrl(
  value: unknown,
  expectedCloudName?: string,
): boolean {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  // Explicitly reject local file URIs and device-internal paths
  if (
    lower.startsWith('file://') ||
    lower.startsWith('file:/') ||
    lower.startsWith('content://') ||
    lower.startsWith('ph://') ||
    lower.startsWith('assets-library://') ||
    lower.startsWith('/data/user/') ||
    lower.startsWith('/data/data/')
  ) {
    return false;
  }

  try {
    const url = new URL(trimmed);

    // 1. Must be HTTPS secure_url
    if (url.protocol !== 'https:') {
      return false;
    }

    const host = url.hostname.toLowerCase();
    const isCloudinaryHost =
      host === 'res.cloudinary.com' || host.endsWith('.cloudinary.com');

    if (!isCloudinaryHost) {
      return false;
    }

    // 2. Cloud name check
    const cloudName = (
      expectedCloudName ||
      process.env.CLOUDINARY_CLOUD_NAME?.trim() ||
      'bhaiway'
    ).toLowerCase();

    const pathSegments = url.pathname.split('/').filter(Boolean);

    if (host === 'res.cloudinary.com') {
      if (pathSegments.length === 0) {
        return false;
      }
      const urlCloudName = pathSegments[0].toLowerCase();
      if (urlCloudName !== cloudName) {
        return false;
      }
    } else if (host.endsWith('.cloudinary.com')) {
      const subdomain = host.replace('.cloudinary.com', '');
      if (subdomain !== cloudName) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function IsCloudinaryUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCloudinaryUrl',
      target: object.constructor,
      propertyName,
      options: {
        message: (args: ValidationArguments) => {
          const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim() || 'bhaiway';
          return `${args.property} must be a valid HTTPS Cloudinary secure_url for cloud '${cloud}' (e.g. https://res.cloudinary.com/${cloud}/image/upload/...)`;
        },
        ...validationOptions,
      },
      validator: {
        validate(value: unknown): boolean {
          return isCloudinaryUrl(value);
        },
      },
    });
  };
}

