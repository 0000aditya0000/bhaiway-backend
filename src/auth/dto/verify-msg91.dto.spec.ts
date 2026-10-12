import { ValidationPipe } from '@nestjs/common';

import { VerifyMsg91Dto } from './verify-msg91.dto';

describe('VerifyMsg91Dto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  async function transform(body: unknown) {
    return pipe.transform(body, {
      type: 'body',
      metatype: VerifyMsg91Dto,
    });
  }

  it('accepts a valid accessToken', async () => {
    await expect(
      transform({ accessToken: 'MSG91_ACCESS_TOKEN' }),
    ).resolves.toEqual({
      accessToken: 'MSG91_ACCESS_TOKEN',
    });
  });

  it('accepts phone + otp for Play review path', async () => {
    await expect(
      transform({ phone: '9761454075', otp: '1234' }),
    ).resolves.toEqual({
      phone: '9761454075',
      otp: '1234',
    });
  });

  it('rejects non-string accessToken', async () => {
    await expect(transform({ accessToken: 12345 })).rejects.toMatchObject({
      response: {
        message: expect.arrayContaining([
          expect.stringMatching(/accessToken/i),
        ]),
      },
    });
  });

  it('rejects unknown properties under forbidNonWhitelisted', async () => {
    await expect(
      transform({
        accessToken: 'MSG91_ACCESS_TOKEN',
        phoneNumber: '+919876543210',
      }),
    ).rejects.toMatchObject({
      response: {
        message: expect.arrayContaining([
          expect.stringMatching(/phoneNumber should not exist/i),
        ]),
      },
    });
  });
});
