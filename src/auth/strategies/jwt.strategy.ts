import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';

import { User, UserStatus } from '../../users/entities/user.entity';
import { isPlatformUserId } from '../../wallet/platform-wallet.constants';

export interface JwtPayload {
  sub: string;
  /** Token version — must match `users.token_version`. Absent ⇒ treated as 0. */
  tv?: number;
}

export interface AuthenticatedUser {
  userId: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload?.sub || isPlatformUserId(payload.sub)) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'INVALID_TOKEN',
        message: 'Invalid authentication token',
        error: 'Unauthorized',
      });
    }

    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
    });
    if (!user) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'INVALID_TOKEN',
        message: 'Invalid authentication token',
        error: 'Unauthorized',
      });
    }

    if (
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.DEACTIVATED
    ) {
      throw new UnauthorizedException({
        statusCode: 401,
        code:
          user.status === UserStatus.SUSPENDED
            ? 'USER_SUSPENDED'
            : 'USER_DEACTIVATED',
        message:
          user.status === UserStatus.SUSPENDED
            ? 'Account is suspended'
            : 'Account is deactivated',
        error: 'Unauthorized',
      });
    }

    const tokenVersion = payload.tv ?? 0;
    if (tokenVersion !== user.tokenVersion) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'TOKEN_REVOKED',
        message: 'Authentication token has been revoked',
        error: 'Unauthorized',
      });
    }

    return {
      userId: user.id,
    };
  }
}
