import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Validates that a string is NOT a local mobile/desktop file URI.
 * Rejects URIs such as `file://`, `file:/`, `content://`, `ph://`, `assets-library://`, `/data/user/`, etc.
 */
export function IsNotLocalFileUri(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotLocalFileUri',
      target: object.constructor,
      propertyName,
      options: {
        message:
          'Invalid profilePhoto: local device URIs (file://, content://) cannot be stored. Please upload the photo via POST /users/profile/photo or provide an HTTP/HTTPS URL.',
        ...validationOptions,
      },
      validator: {
        validate(value: unknown): boolean {
          if (value === null || value === undefined || value === '') {
            return true;
          }
          if (typeof value !== 'string') {
            return false;
          }
          const lower = value.trim().toLowerCase();
          return !(
            lower.startsWith('file://') ||
            lower.startsWith('file:/') ||
            lower.startsWith('content://') ||
            lower.startsWith('ph://') ||
            lower.startsWith('assets-library://') ||
            lower.startsWith('/data/user/') ||
            lower.startsWith('/data/data/')
          );
        },
      },
    });
  };
}
