import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { UserStatus } from '../../users/entities/user.entity';
import { ALLOW_DELETION_PENDING_KEY } from '../decorators/allow-deletion-pending.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedUser } from '../strategies/jwt.strategy';

const DELETION_PENDING_STATUSES: readonly UserStatus[] = [
  UserStatus.DELETION_REQUESTED,
  UserStatus.DELETION_ACTION_REQUIRED,
  UserStatus.DELETION_APPROVED,
];

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector?: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (isPublic) {
        return true;
      }
    }

    const can = await super.canActivate(context);
    if (!can) {
      return false;
    }

    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
    }>();
    const user = request.user;
    if (!user) {
      return true;
    }

    const allowDeletion = this.reflector
      ? this.reflector.getAllAndOverride<boolean>(ALLOW_DELETION_PENDING_KEY, [
          context.getHandler(),
          context.getClass(),
        ])
      : false;

    const isDeletionPending =
      user.status && DELETION_PENDING_STATUSES.includes(user.status);
    const hasRestrictedScope = user.scope === 'restricted_deletion';

    if ((isDeletionPending || hasRestrictedScope) && !allowDeletion) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ACCOUNT_DELETION_PENDING',
        message:
          'Your account is pending deletion. Regular application access is restricted.',
        error: 'Forbidden',
      });
    }

    return true;
  }
}
