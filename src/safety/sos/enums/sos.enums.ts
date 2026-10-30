export enum SosStatus {
  TRIGGERED = 'TRIGGERED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  RESPONDING = 'RESPONDING',
  RESOLVED = 'RESOLVED',
  FALSE_ALARM = 'FALSE_ALARM',
}

export enum SosSeverity {
  CRITICAL = 'CRITICAL',
}

export enum SosCategory {
  EMERGENCY = 'EMERGENCY',
  UNSAFE_DRIVER = 'UNSAFE_DRIVER',
  ACCIDENT = 'ACCIDENT',
  MEDICAL = 'MEDICAL',
  HARASSMENT = 'HARASSMENT',
  OTHER = 'OTHER',
}

export enum SosParticipantRole {
  DRIVER = 'DRIVER',
  PASSENGER = 'PASSENGER',
}

export enum SosActorType {
  USER = 'USER',
  ADMIN = 'ADMIN',
  SYSTEM = 'SYSTEM',
}

export enum SosTimelineEventType {
  TRIGGERED = 'TRIGGERED',
  ADDITIONAL_TRIGGER = 'ADDITIONAL_TRIGGER',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  RESPONSE_STARTED = 'RESPONSE_STARTED',
  NOTE_ADDED = 'NOTE_ADDED',
  ASSIGNED = 'ASSIGNED',
  ESCALATED = 'ESCALATED',
  RESOLVED = 'RESOLVED',
  FALSE_ALARM = 'FALSE_ALARM',
}

export enum SosLocationFreshness {
  AVAILABLE = 'AVAILABLE',
  STALE = 'STALE',
  MISSING = 'MISSING',
}

export enum SafetyIncidentStatus {
  OPEN = 'OPEN',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  ASSIGNED = 'ASSIGNED',
  ESCALATED = 'ESCALATED',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export enum SafetyIncidentType {
  SOS = 'SOS',
}

export enum SafetyIncidentSeverity {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export const ACTIVE_SOS_STATUSES: SosStatus[] = [
  SosStatus.TRIGGERED,
  SosStatus.ACKNOWLEDGED,
  SosStatus.RESPONDING,
];

export const OPEN_INCIDENT_STATUSES: SafetyIncidentStatus[] = [
  SafetyIncidentStatus.OPEN,
  SafetyIncidentStatus.ACKNOWLEDGED,
  SafetyIncidentStatus.ASSIGNED,
  SafetyIncidentStatus.ESCALATED,
];
