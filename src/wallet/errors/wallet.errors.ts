import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

export class WalletNotFoundError extends NotFoundException {
  constructor(walletId?: string) {
    super(
      walletId
        ? `Wallet not found: ${walletId}`
        : 'Wallet not found',
    );
  }
}

export class WalletBalanceNotFoundError extends NotFoundException {
  constructor(walletId?: string) {
    super(
      walletId
        ? `Wallet balance not found for wallet: ${walletId}`
        : 'Wallet balance not found',
    );
  }
}

export class InsufficientWalletBalanceError extends UnprocessableEntityException {
  constructor(message = 'Insufficient wallet balance') {
    super(message);
  }
}

export class InvalidWalletAmountError extends BadRequestException {
  constructor(message = 'Wallet amount must be greater than zero') {
    super(message);
  }
}

export class PointLotNotFoundError extends NotFoundException {
  constructor(pointLotId?: string) {
    super(
      pointLotId
        ? `Point lot not found: ${pointLotId}`
        : 'Point lot not found',
    );
  }
}

export class WalletHoldNotFoundError extends NotFoundException {
  constructor(holdId?: string) {
    super(
      holdId ? `Wallet hold not found: ${holdId}` : 'Wallet hold not found',
    );
  }
}

export class WalletHoldNotActiveError extends ConflictException {
  constructor(holdId?: string) {
    super(
      holdId
        ? `Wallet hold is not active: ${holdId}`
        : 'Wallet hold is not active',
    );
  }
}

export class WalletHoldAlreadyReleasedError extends ConflictException {
  constructor(holdId?: string) {
    super(
      holdId
        ? `Wallet hold already released: ${holdId}`
        : 'Wallet hold already released',
    );
  }
}

export class WalletHoldAlreadyConsumedError extends ConflictException {
  constructor(holdId?: string) {
    super(
      holdId
        ? `Wallet hold already consumed: ${holdId}`
        : 'Wallet hold already consumed',
    );
  }
}

export class WalletOperationConflictError extends ConflictException {
  constructor(message = 'Wallet operation conflict') {
    super(message);
  }
}

export class PlatformWalletForbiddenError extends ForbiddenException {
  constructor(
    message = 'Platform wallet cannot be used through normal user wallet operations',
  ) {
    super(message);
  }
}
