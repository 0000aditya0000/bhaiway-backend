/** Socket.IO client → server */
export const TRACKING_SOCKET_EVENTS = {
  JOIN: 'tracking:join',
  LEAVE: 'tracking:leave',
  DRIVER_LOCATION_UPDATE: 'driver:location:update',
} as const;

/** Socket.IO server → client */
export const TRACKING_SERVER_EVENTS = {
  LOCATION_UPDATED: 'ride:location:updated',
  TRACKING_ENDED: 'ride:tracking:ended',
  ERROR: 'tracking:error',
} as const;

export const TRACKING_SOCKET_NAMESPACE = '/tracking';
