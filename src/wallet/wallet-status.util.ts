import { ForbiddenException } from '@nestjs/common';

import { Wallet, WalletStatus } from './entities/wallet.entity';

/** Top-up is permitted only when the wallet is ACTIVE. */
export function assertWalletAllowsTopUp(wallet: Wallet): void {
  if (wallet.status === WalletStatus.SUSPENDED) {
    throw new ForbiddenException('Wallet is suspended');
  }
  if (wallet.status === WalletStatus.LOCKED) {
    throw new ForbiddenException('Wallet is locked');
  }
}
