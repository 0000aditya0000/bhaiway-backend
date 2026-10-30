import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

import { SOS_DOMAIN_EVENTS } from './sos.events';

export interface SosCreatedDomainEvent {
  sosId: string;
  rideId: string;
  originalTriggerUserId: string;
  triggeredAt: string;
}

/**
 * In-process domain bus for SOS lifecycle.
 * Future trusted-contact SMS should subscribe to `sos.created`.
 * This service never sends SMS.
 */
@Injectable()
export class SosEventsService {
  private readonly logger = new Logger(SosEventsService.name);
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(20);
  }

  emitCreated(event: SosCreatedDomainEvent): void {
    this.emitter.emit(SOS_DOMAIN_EVENTS.CREATED, event);
    this.logger.log(`sos.created sos=${event.sosId} ride=${event.rideId}`);
  }

  emitAdditionalTrigger(
    event: SosCreatedDomainEvent & { userId: string },
  ): void {
    this.emitter.emit(SOS_DOMAIN_EVENTS.ADDITIONAL_TRIGGER, event);
  }

  onCreated(handler: (event: SosCreatedDomainEvent) => void): void {
    this.emitter.on(SOS_DOMAIN_EVENTS.CREATED, handler);
  }
}
