import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { AdminUser } from '../entities/admin-user.entity';
import { ADMIN_PERMISSIONS_KEY } from '../decorators/require-admin-permission.decorator';

@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(AdminUser)
    private readonly adminUserRepository: Repository<AdminUser>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<string[]>(ADMIN_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
    }>();
    const userId = request.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Missing authenticated user');
    }

    const admin = await this.adminUserRepository.findOne({
      where: { userId, isActive: true },
    });
    if (!admin) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ADMIN_ACCESS_DENIED',
        message: 'Admin access required',
        error: 'Forbidden',
      });
    }

    if (required.length > 0) {
      const granted = new Set(admin.permissions ?? []);
      const missing = required.filter((p) => !granted.has(p));
      if (missing.length > 0) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'ADMIN_PERMISSION_DENIED',
          message: 'Missing required admin permission',
          error: 'Forbidden',
        });
      }
    }

    (request as { adminUser?: AdminUser }).adminUser = admin;
    return true;
  }
}
