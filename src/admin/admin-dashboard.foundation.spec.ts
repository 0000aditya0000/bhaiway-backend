import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';

import { WalletTransactionType } from '../wallet/entities/wallet-transaction.entity';
import { AdminPermissionGuard } from './guards/admin-permission.guard';
import { AdminUser } from './entities/admin-user.entity';
import {
  ADMIN_PERMISSION_DASHBOARD_VIEW,
  PLATFORM_REVENUE_TRANSACTION_TYPES,
} from './admin.constants';
import { AdminLiveMapFilter } from './dto/admin-dashboard-query.dto';

describe('Admin dashboard foundations', () => {
  describe('platform revenue types', () => {
    it('includes only explicit platform-wallet revenue ledger types', () => {
      expect(PLATFORM_REVENUE_TRANSACTION_TYPES).toEqual([
        WalletTransactionType.COMMUTE_PLATFORM_MARGIN,
        WalletTransactionType.ASSURED_PLATFORM_FORFEITURE,
        WalletTransactionType.ASSURED_PASSENGER_CANCEL_FARE_PLATFORM,
      ]);
    });

    it('does not treat rider payments, driver earnings, top-ups, or seed as revenue', () => {
      const excluded = [
        WalletTransactionType.BOOKING_PAYMENT,
        WalletTransactionType.DRIVER_EARNING,
        WalletTransactionType.POINT_PURCHASE,
        WalletTransactionType.PLATFORM_SEED,
        WalletTransactionType.REFUND,
        WalletTransactionType.ASSURED_DEPOSIT_HOLD,
        WalletTransactionType.HOLD_RELEASE,
        WalletTransactionType.ADMIN_ADJUSTMENT,
      ];
      for (const type of excluded) {
        expect(PLATFORM_REVENUE_TRANSACTION_TYPES).not.toContain(type);
      }
    });
  });

  describe('live map filters', () => {
    it('exposes ACTIVE, OFFICE_COMMUTE, OUTSTATION, SOS', () => {
      expect(Object.values(AdminLiveMapFilter)).toEqual([
        'ACTIVE',
        'OFFICE_COMMUTE',
        'OUTSTATION',
        'SOS',
      ]);
    });
  });

  describe('AdminPermissionGuard', () => {
    function makeContext(userId?: string) {
      return {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({ user: userId ? { userId } : undefined }),
        }),
      } as any;
    }

    it('rejects non-admin users', async () => {
      const reflector = {
        getAllAndOverride: () => [ADMIN_PERMISSION_DASHBOARD_VIEW],
      } as unknown as Reflector;
      const repo = {
        findOne: jest.fn().mockResolvedValue(null),
      } as unknown as Repository<AdminUser>;
      const guard = new AdminPermissionGuard(reflector, repo);

      await expect(guard.canActivate(makeContext('user-1'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('allows active admin with ADMIN_DASHBOARD_VIEW', async () => {
      const reflector = {
        getAllAndOverride: () => [ADMIN_PERMISSION_DASHBOARD_VIEW],
      } as unknown as Reflector;
      const repo = {
        findOne: jest.fn().mockResolvedValue({
          userId: 'admin-1',
          isActive: true,
          permissions: [ADMIN_PERMISSION_DASHBOARD_VIEW],
        }),
      } as unknown as Repository<AdminUser>;
      const guard = new AdminPermissionGuard(reflector, repo);

      await expect(guard.canActivate(makeContext('admin-1'))).resolves.toBe(true);
    });

    it('rejects admin missing required permission', async () => {
      const reflector = {
        getAllAndOverride: () => [ADMIN_PERMISSION_DASHBOARD_VIEW],
      } as unknown as Reflector;
      const repo = {
        findOne: jest.fn().mockResolvedValue({
          userId: 'admin-1',
          isActive: true,
          permissions: [],
        }),
      } as unknown as Repository<AdminUser>;
      const guard = new AdminPermissionGuard(reflector, repo);

      await expect(guard.canActivate(makeContext('admin-1'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
