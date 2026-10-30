/** Socket.IO client → server */
export const TRACKING_SOCKET_EVENTS = {
  JOIN: 'tracking:join',
  LEAVE: 'tracking:leave',
  DRIVER_LOCATION_UPDATE: 'driver:location:update',
  ADMIN_SAFETY_JOIN: 'admin:safety:join',
} as const;

/** Socket.IO server → client */
export const TRACKING_SERVER_EVENTS = {
  LOCATION_UPDATED: 'ride:location:updated',
  TRACKING_ENDED: 'ride:tracking:ended',
  RIDE_CANCELLED: 'ride:cancelled',
  ERROR: 'tracking:error',
} as const;

export const SOS_SERVER_EVENTS = {
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

export const TRACKING_SOCKET_NAMESPACE = '/tracking';
