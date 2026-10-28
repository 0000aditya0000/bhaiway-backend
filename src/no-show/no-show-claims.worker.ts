import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { NO_SHOW_WORKER_POLL_MS } from './no-show.constants';
import { NoShowClaimsService } from './no-show-claims.service';

@Injectable()
export class NoShowClaimsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NoShowClaimsWorker.name);
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly noShowClaimsService: NoShowClaimsService) {}

  onModuleInit(): void {
    void this.poll();
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, NO_SHOW_WORKER_POLL_MS);
    this.pollTimer.unref?.();
  }

  private poll(): Promise<void> {
    return this.noShowClaimsService
      .processDueClaims()
      .then(() => this.noShowClaimsService.processPendingEffects())
      .then(
        () => undefined,
        (error) => {
          this.logger.warn(
            `No-Show due-claim poll failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
