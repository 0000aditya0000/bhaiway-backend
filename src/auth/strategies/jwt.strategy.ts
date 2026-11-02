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
  /** Optional token scope, e.g. 'restricted_deletion' */
  scope?: string;
}

export interface AuthenticatedUser {
  userId: string;
  scope?: string;
  status?: UserStatus;
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

    if (user.status === UserStatus.DELETED) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'USER_DELETED',
        message: 'Account has been deleted',
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

    const result: AuthenticatedUser = {
      userId: user.id,
    };

    if (payload.scope) {
      result.scope = payload.scope;
    }

    if (
      user.status === UserStatus.DELETION_REQUESTED ||
      user.status === UserStatus.DELETION_ACTION_REQUIRED ||
      user.status === UserStatus.DELETION_APPROVED
    ) {
      result.status = user.status;
    }

    return result;
  }
}
