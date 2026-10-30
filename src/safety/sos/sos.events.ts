export const SOS_SOCKET_EVENTS = {
  DRIVER_ALERT: 'sos:driver-alert',
  PASSENGER_ALERT: 'sos:passenger-alert',
  TRIGGERED: 'sos:triggered',
  ADDITIONAL_TRIGGER: 'sos:additional-trigger',
  ACKNOWLEDGED: 'sos:acknowledged',
  RESPONDING: 'sos:responding',
  RESOLVED: 'sos:resolved',
  FALSE_ALARM: 'sos:false-alarm',
  LOCATION_UPDATED: 'sos:location-updated',
  INCIDENT_CREATED: 'incident:created',
  INCIDENT_UPDATED: 'incident:updated',
  INCIDENT_NOTE_ADDED: 'incident:note-added',
} as const;

export function trackingUserRoom(userId: string): string {
  return `user:${userId}`;
}

export function adminSafetyRoom(): string {
  return 'admin:safety';
}

/** Domain event for future trusted-contact SMS (not implemented). */
export const SOS_DOMAIN_EVENTS = {
  CREATED: 'sos.created',
  ADDITIONAL_TRIGGER: 'sos.additional-trigger',
} as const;
