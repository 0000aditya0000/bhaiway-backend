import type { CashfreeVehicleRcApiResponse } from '../verification/cashfree/cashfree-vehicle-rc.service';
import {
  PublicVehicleRcStatus,
  VehicleRcVerificationStatus,
} from '../verification/enums/vehicle-rc-verification.enums';
import { VehicleType } from './enums/vehicle-type.enum';

export enum FieldCheckStatus {
  MATCHED = 'MATCHED',
  MISMATCHED = 'MISMATCHED',
  NOT_AVAILABLE = 'NOT_AVAILABLE',
}

export interface FieldCheck {
  status: FieldCheckStatus;
  userValue: string | null;
  rcValue: string | null;
}

export interface RcVerificationErrorItem {
  code: string;
  field: string;
  message: string;
}

export interface RcFieldChecks {
  registrationNumber: FieldCheck;
  vehicleName: FieldCheck;
  make: FieldCheck;
  model: FieldCheck;
  colour: FieldCheck;
  vehicleType: FieldCheck;
  insurance: FieldCheck;
  vehicleStatus: FieldCheck;
}

export interface RcEvaluationResult {
  passed: boolean;
  verificationStatus: 'VERIFIED' | 'FAILED';
  persistenceStatus: VehicleRcVerificationStatus;
  checks: RcFieldChecks;
  errors: RcVerificationErrorItem[];
  primaryCode: string;
  primaryMessage: string;
}

export interface SavedVehicleIdentity {
  registrationNumber: string;
  make: string;
  model: string;
  color: string | null;
  vehicleType: VehicleType;
}

export const RC_ERROR_CODES = {
  VEHICLE_DETAILS_MISMATCH: 'VEHICLE_DETAILS_MISMATCH',
  VEHICLE_NUMBER_MISMATCH: 'VEHICLE_NUMBER_MISMATCH',
  INSURANCE_EXPIRED: 'INSURANCE_EXPIRED',
  INSURANCE_INVALID: 'INSURANCE_INVALID',
  INSURANCE_DETAILS_UNAVAILABLE: 'INSURANCE_DETAILS_UNAVAILABLE',
  VEHICLE_STATUS_INVALID: 'VEHICLE_STATUS_INVALID',
  VEHICLE_RC_INVALID: 'VEHICLE_RC_INVALID',
  RC_PROVIDER_UNAVAILABLE: 'RC_PROVIDER_UNAVAILABLE',
} as const;

const MAKE_ALIAS_GROUPS: string[][] = [
  ['HONDA', 'HMSI', 'HONDA MOTOR', 'HONDA CARS', 'HONDA CAR'],
  ['MARUTI', 'MARUTI SUZUKI', 'SUZUKI', 'MSIL'],
  ['HYUNDAI', 'HYUNDAI MOTOR', 'HYUNDAI MOTORS', 'HMI'],
  ['TATA', 'TML', 'TATA MOTORS', 'TATA MOTOR'],
  ['MAHINDRA', 'M AND M', 'MAHINDRA AND MAHINDRA'],
  ['BAJAJ', 'BAJAJ AUTO'],
  ['TVS', 'TVS MOTOR', 'TVS MOTORS'],
  ['HERO', 'HERO MOTOCORP', 'HHML', 'HERO HONDA'],
  ['YAMAHA', 'INDIA YAMAHA', 'YAMAHA MOTOR'],
  ['KIA', 'KIA MOTORS', 'KIA MOTOR'],
  ['TOYOTA', 'TKM', 'TOYOTA KIRLOSKAR'],
  ['MG', 'MORRIS GARAGES', 'MG MOTOR'],
  ['RENAULT', 'RENAULT INDIA'],
  ['SKODA', 'SKODA AUTO'],
  ['VOLKSWAGEN', 'VW', 'VOLKSWAGEN INDIA'],
  ['FORD', 'FORD INDIA'],
  ['NISSAN', 'NISSAN MOTOR'],
  ['ROYAL ENFIELD', 'EICHER', 'RE'],
];

const COLOUR_ALIAS_GROUPS: string[][] = [
  ['WHITE', 'WHT'],
  ['BLACK', 'BLK'],
  ['GREY', 'GRAY', 'GRY'],
  ['SILVER', 'SLV', 'SIL'],
  ['RED'],
  ['BLUE', 'BLU'],
  ['GREEN', 'GRN'],
  ['BROWN', 'BRN'],
  ['GOLD', 'GLD'],
  ['ORANGE', 'ORG'],
  ['YELLOW', 'YLW'],
  ['MAROON'],
  ['BEIGE'],
  ['PURPLE'],
  ['PINK'],
];

const CAR_TYPE_ALIASES = [
  'CAR',
  'LMV',
  'LMVE',
  'MOTOR CAR',
  'MOTORCAR',
  'FOUR WHEELER',
  '4W',
  'M1',
  'LMV NT',
];

const BIKE_TYPE_ALIASES = [
  'BIKE',
  'MCWG',
  'MCWOG',
  '2WN',
  'MOTORCYCLE',
  'SCOOTER',
  'TWO WHEELER',
  '2W',
  'MOPED',
  'SCOOTY',
];

const VALID_RC_STATUSES = new Set([
  'ACTIVE',
  'VALID',
  'LIVE',
  'ACTIVE RC',
  'RC ACTIVE',
]);

const INVALID_RC_STATUSES = new Set([
  'EXPIRED',
  'INACTIVE',
  'CANCELLED',
  'CANCELED',
  'SUSPENDED',
  'INVALID',
  'NOT ACTIVE',
  'BLACKLISTED',
  'SOLD',
  'TRANSFERRED',
  'RC NOT ACTIVE',
]);

const INSURANCE_UNAVAILABLE_TOKENS = new Set([
  'NA',
  'N A',
  'N/A',
  'NIL',
  'NULL',
  'NONE',
  'UNKNOWN',
  'NOT AVAILABLE',
  'UNAVAILABLE',
]);

const INSURANCE_INVALID_TOKENS = new Set([
  'EXPIRED',
  'INVALID',
  'INACTIVE',
  'CANCELLED',
  'CANCELED',
  'LAPSED',
]);

const INSURANCE_LIFETIME_TOKENS = new Set([
  'LTT',
  'LT',
  'LLT',
  'LIFE TIME',
  'LIFETIME',
  'PERMANENT',
]);

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const IN_FLIGHT_WINDOW_MS = 120_000;

export const RC_VERIFICATION_IN_FLIGHT_MS = IN_FLIGHT_WINDOW_MS;

export function normalizeRegistrationNumber(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

export function normalizeComparableText(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactComparableText(value: string): string {
  return normalizeComparableText(value).replace(/\s+/g, '');
}

export function toPublicVehicleRcStatus(
  status: VehicleRcVerificationStatus | null | undefined,
): PublicVehicleRcStatus {
  if (!status) {
    return PublicVehicleRcStatus.NOT_VERIFIED;
  }
  if (status === VehicleRcVerificationStatus.PENDING) {
    return PublicVehicleRcStatus.PENDING;
  }
  if (status === VehicleRcVerificationStatus.VALID) {
    return PublicVehicleRcStatus.VERIFIED;
  }
  return PublicVehicleRcStatus.FAILED;
}

export function evaluateVehicleRcChecks(
  vehicle: SavedVehicleIdentity,
  provider: CashfreeVehicleRcApiResponse,
): RcEvaluationResult {
  const userReg = normalizeRegistrationNumber(vehicle.registrationNumber);
  const providerRegRaw = provider.regNo || provider.vehicleNumber || '';
  const providerReg = providerRegRaw
    ? normalizeRegistrationNumber(providerRegRaw)
    : '';

  const registrationNumber = compareRequiredExact(
    userReg,
    providerReg,
    providerRegRaw || null,
  );

  const make = compareMake(vehicle.make, provider.vehicleManufacturerName);
  const model = compareModel(vehicle.model, provider.model);
  const vehicleName = combineNameCheck(
    vehicle.make,
    vehicle.model,
    provider.vehicleManufacturerName,
    provider.model,
    make,
    model,
  );
  const colour = compareColour(vehicle.color, provider.vehicleColor);
  const vehicleType = compareVehicleType(
    vehicle.vehicleType,
    provider.class,
    provider.vehicleCategory,
  );
  const insurance = evaluateInsurance(
    provider.vehicleInsuranceUpto,
    provider.vehicleInsuranceCompanyName,
  );
  const vehicleStatus = evaluateVehicleStatus(
    provider.rcStatus,
    provider.blacklistStatus,
  );

  const checks: RcFieldChecks = {
    registrationNumber,
    vehicleName,
    make,
    model,
    colour,
    vehicleType,
    insurance,
    vehicleStatus,
  };

  const errors: RcVerificationErrorItem[] = [];

  if (provider.status !== 'VALID') {
    errors.push({
      code: RC_ERROR_CODES.VEHICLE_RC_INVALID,
      field: 'rcStatus',
      message: provider.failureReason || 'Vehicle RC is invalid',
    });
  }

  pushIdentityErrors(errors, checks);
  pushComplianceErrors(errors, checks);

  const passed = errors.length === 0;
  const primary = errors[0];

  return {
    passed,
    verificationStatus: passed ? 'VERIFIED' : 'FAILED',
    persistenceStatus: passed
      ? VehicleRcVerificationStatus.VALID
      : VehicleRcVerificationStatus.INVALID,
    checks,
    errors,
    primaryCode: primary?.code ?? RC_ERROR_CODES.VEHICLE_RC_INVALID,
    primaryMessage: primary?.message ?? 'Vehicle RC verification failed',
  };
}

function compareRequiredExact(
  userValue: string,
  rcNormalized: string,
  rcDisplay: string | null,
): FieldCheck {
  if (!rcNormalized) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue,
      rcValue: null,
    };
  }
  return {
    status:
      userValue === rcNormalized
        ? FieldCheckStatus.MATCHED
        : FieldCheckStatus.MISMATCHED,
    userValue,
    rcValue: rcDisplay,
  };
}

function compareMake(userMake: string, providerMake?: string): FieldCheck {
  const userValue = userMake.trim();
  const rcValue = present(providerMake);
  if (!rcValue) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue,
      rcValue: null,
    };
  }
  return {
    status: makesMatch(userValue, rcValue)
      ? FieldCheckStatus.MATCHED
      : FieldCheckStatus.MISMATCHED,
    userValue,
    rcValue,
  };
}

function compareModel(userModel: string, providerModel?: string): FieldCheck {
  const userValue = userModel.trim();
  const rcValue = present(providerModel);
  if (!rcValue) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue,
      rcValue: null,
    };
  }
  return {
    status: modelsMatch(userValue, rcValue)
      ? FieldCheckStatus.MATCHED
      : FieldCheckStatus.MISMATCHED,
    userValue,
    rcValue,
  };
}

function combineNameCheck(
  userMake: string,
  userModel: string,
  providerMake: string | undefined,
  providerModel: string | undefined,
  make: FieldCheck,
  model: FieldCheck,
): FieldCheck {
  const userValue = `${userMake.trim()} ${userModel.trim()}`.trim();
  const rcParts = [present(providerMake), present(providerModel)].filter(
    (part): part is string => Boolean(part),
  );
  const rcValue = rcParts.length > 0 ? rcParts.join(' ') : null;

  if (
    make.status === FieldCheckStatus.MISMATCHED ||
    model.status === FieldCheckStatus.MISMATCHED
  ) {
    return {
      status: FieldCheckStatus.MISMATCHED,
      userValue,
      rcValue,
    };
  }

  if (
    make.status === FieldCheckStatus.NOT_AVAILABLE &&
    model.status === FieldCheckStatus.NOT_AVAILABLE
  ) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue,
      rcValue: null,
    };
  }

  return {
    status: FieldCheckStatus.MATCHED,
    userValue,
    rcValue,
  };
}

function compareColour(
  userColor: string | null,
  providerColor?: string,
): FieldCheck {
  const userValue = present(userColor);
  const rcValue = present(providerColor);
  if (!userValue || !rcValue) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue,
      rcValue,
    };
  }
  return {
    status: coloursMatch(userValue, rcValue)
      ? FieldCheckStatus.MATCHED
      : FieldCheckStatus.MISMATCHED,
    userValue,
    rcValue,
  };
}

function compareVehicleType(
  userType: VehicleType,
  providerClass?: string,
  providerCategory?: string,
): FieldCheck {
  const rcValue = present(providerClass) || present(providerCategory);
  if (!rcValue) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue: userType,
      rcValue: null,
    };
  }
  return {
    status: vehicleTypesMatch(userType, rcValue)
      ? FieldCheckStatus.MATCHED
      : FieldCheckStatus.MISMATCHED,
    userValue: userType,
    rcValue,
  };
}

function evaluateInsurance(
  insuranceUpto?: string,
  insuranceCompany?: string,
): FieldCheck {
  const raw = present(insuranceUpto);
  const company = present(insuranceCompany);
  const display = raw ?? company;

  if (!raw) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue: null,
      rcValue: display,
    };
  }

  const normalized = normalizeComparableText(raw);
  if (INSURANCE_LIFETIME_TOKENS.has(normalized)) {
    return {
      status: FieldCheckStatus.MATCHED,
      userValue: null,
      rcValue: raw,
    };
  }
  if (INSURANCE_UNAVAILABLE_TOKENS.has(normalized)) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue: null,
      rcValue: raw,
    };
  }
  if (INSURANCE_INVALID_TOKENS.has(normalized)) {
    return {
      status: FieldCheckStatus.MISMATCHED,
      userValue: null,
      rcValue: raw,
    };
  }

  const parsed = parseRcDate(raw);
  if (!parsed) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue: null,
      rcValue: raw,
    };
  }

  const today = new Date();
  const todayKey = toDateKey(today);
  const expiryKey = toDateKey(parsed);
  if (expiryKey < todayKey) {
    return {
      status: FieldCheckStatus.MISMATCHED,
      userValue: null,
      rcValue: raw,
    };
  }

  return {
    status: FieldCheckStatus.MATCHED,
    userValue: null,
    rcValue: raw,
  };
}

function evaluateVehicleStatus(
  rcStatus?: string,
  blacklistStatus?: string,
): FieldCheck {
  const statusValue = present(rcStatus);
  const blacklist = present(blacklistStatus);
  const rcValue = [statusValue, blacklist].filter(Boolean).join(' / ') || null;

  if (blacklist && isBlacklisted(blacklist)) {
    return {
      status: FieldCheckStatus.MISMATCHED,
      userValue: 'ACTIVE',
      rcValue,
    };
  }

  if (!statusValue) {
    return {
      status: FieldCheckStatus.NOT_AVAILABLE,
      userValue: 'ACTIVE',
      rcValue,
    };
  }

  const normalized = normalizeComparableText(statusValue);
  if (INVALID_RC_STATUSES.has(normalized)) {
    return {
      status: FieldCheckStatus.MISMATCHED,
      userValue: 'ACTIVE',
      rcValue: statusValue,
    };
  }
  if (VALID_RC_STATUSES.has(normalized)) {
    return {
      status: FieldCheckStatus.MATCHED,
      userValue: 'ACTIVE',
      rcValue: statusValue,
    };
  }

  return {
    status: FieldCheckStatus.NOT_AVAILABLE,
    userValue: 'ACTIVE',
    rcValue: statusValue,
  };
}

function pushIdentityErrors(
  errors: RcVerificationErrorItem[],
  checks: RcFieldChecks,
): void {
  if (checks.registrationNumber.status === FieldCheckStatus.MISMATCHED) {
    errors.push({
      code: RC_ERROR_CODES.VEHICLE_NUMBER_MISMATCH,
      field: 'registrationNumber',
      message: 'Registration number does not match RC records.',
    });
  } else if (
    checks.registrationNumber.status === FieldCheckStatus.NOT_AVAILABLE
  ) {
    errors.push({
      code: RC_ERROR_CODES.VEHICLE_DETAILS_MISMATCH,
      field: 'registrationNumber',
      message: 'Registration number was not returned by the RC provider.',
    });
  }

  if (checks.vehicleName.status === FieldCheckStatus.MISMATCHED) {
    const field =
      checks.make.status === FieldCheckStatus.MISMATCHED
        ? 'make'
        : checks.model.status === FieldCheckStatus.MISMATCHED
          ? 'model'
          : 'vehicleName';
    errors.push({
      code: RC_ERROR_CODES.VEHICLE_DETAILS_MISMATCH,
      field,
      message: 'Vehicle name does not match RC records.',
    });
  } else if (checks.vehicleName.status === FieldCheckStatus.NOT_AVAILABLE) {
    errors.push({
      code: RC_ERROR_CODES.VEHICLE_DETAILS_MISMATCH,
      field: 'vehicleName',
      message: 'Vehicle make/model was not returned by the RC provider.',
    });
  }

  if (checks.colour.status === FieldCheckStatus.MISMATCHED) {
    errors.push({
      code: RC_ERROR_CODES.VEHICLE_DETAILS_MISMATCH,
      field: 'colour',
      message: 'Vehicle colour does not match RC records.',
    });
  }

  if (checks.vehicleType.status === FieldCheckStatus.MISMATCHED) {
    errors.push({
      code: RC_ERROR_CODES.VEHICLE_DETAILS_MISMATCH,
      field: 'vehicleType',
      message: 'Vehicle type does not match RC records.',
    });
  }
}

function pushComplianceErrors(
  errors: RcVerificationErrorItem[],
  checks: RcFieldChecks,
): void {
  if (checks.vehicleStatus.status === FieldCheckStatus.MISMATCHED) {
    errors.push({
      code: RC_ERROR_CODES.VEHICLE_STATUS_INVALID,
      field: 'vehicleStatus',
      message: 'Vehicle registration status is not valid.',
    });
  }

  if (checks.insurance.status === FieldCheckStatus.MATCHED) {
    return;
  }

  const insuranceValue = (checks.insurance.rcValue ?? '').toUpperCase();
  const normalized = normalizeComparableText(insuranceValue);

  if (checks.insurance.status === FieldCheckStatus.NOT_AVAILABLE) {
    errors.push({
      code: RC_ERROR_CODES.INSURANCE_DETAILS_UNAVAILABLE,
      field: 'insurance',
      message: 'Insurance details were not available from the RC provider.',
    });
    return;
  }

  if (INSURANCE_INVALID_TOKENS.has(normalized)) {
    errors.push({
      code: RC_ERROR_CODES.INSURANCE_INVALID,
      field: 'insurance',
      message: 'Vehicle insurance is invalid or inactive.',
    });
    return;
  }

  const parsed = parseRcDate(checks.insurance.rcValue ?? '');
  if (parsed && toDateKey(parsed) < toDateKey(new Date())) {
    errors.push({
      code: RC_ERROR_CODES.INSURANCE_EXPIRED,
      field: 'insurance',
      message: 'Vehicle insurance has expired.',
    });
    return;
  }

  errors.push({
    code: RC_ERROR_CODES.INSURANCE_INVALID,
    field: 'insurance',
    message: 'Vehicle insurance is invalid or inactive.',
  });
}

function makesMatch(userMake: string, providerMake: string): boolean {
  const userNorm = normalizeComparableText(userMake);
  const providerNorm = normalizeComparableText(providerMake);
  if (!userNorm || !providerNorm) {
    return false;
  }
  if (userNorm === providerNorm) {
    return true;
  }

  const userCompact = compactComparableText(userMake);
  const providerCompact = compactComparableText(providerMake);
  if (
    userCompact.length >= 4 &&
    providerCompact.length >= 4 &&
    (providerCompact.includes(userCompact) ||
      userCompact.includes(providerCompact))
  ) {
    return true;
  }

  return aliasesOverlap(userNorm, providerNorm, MAKE_ALIAS_GROUPS);
}

function modelsMatch(userModel: string, providerModel: string): boolean {
  const userNorm = normalizeComparableText(userModel);
  const providerNorm = normalizeComparableText(providerModel);
  if (!userNorm || !providerNorm) {
    return false;
  }
  if (userNorm === providerNorm) {
    return true;
  }

  const userCompact = compactComparableText(userModel);
  const providerCompact = compactComparableText(providerModel);
  if (userCompact && userCompact === providerCompact) {
    return true;
  }

  const userTokens = userNorm.split(' ').filter((token) => token.length >= 2);
  const providerTokens = providerNorm
    .split(' ')
    .filter((token) => token.length >= 2);
  if (userTokens.length === 0 || providerTokens.length === 0) {
    return false;
  }

  const userInProvider = userTokens.every((token) =>
    providerTokens.includes(token),
  );
  const providerInUser = providerTokens.every((token) =>
    userTokens.includes(token),
  );
  return userInProvider || providerInUser;
}

function coloursMatch(userColor: string, providerColor: string): boolean {
  const userNorm = normalizeComparableText(userColor);
  const providerNorm = normalizeComparableText(providerColor);
  if (!userNorm || !providerNorm) {
    return false;
  }
  if (userNorm === providerNorm) {
    return true;
  }
  if (
    compactComparableText(userColor) === compactComparableText(providerColor)
  ) {
    return true;
  }
  return aliasesOverlap(userNorm, providerNorm, COLOUR_ALIAS_GROUPS);
}

function vehicleTypesMatch(
  userType: VehicleType,
  providerValue: string,
): boolean {
  const normalized = normalizeComparableText(providerValue);
  const aliases =
    userType === VehicleType.BIKE ? BIKE_TYPE_ALIASES : CAR_TYPE_ALIASES;
  if (aliases.some((alias) => normalized.includes(alias))) {
    return true;
  }
  const opposite =
    userType === VehicleType.BIKE ? CAR_TYPE_ALIASES : BIKE_TYPE_ALIASES;
  if (opposite.some((alias) => normalized.includes(alias))) {
    return false;
  }
  return normalized.includes(userType);
}

function aliasesOverlap(
  left: string,
  right: string,
  groups: string[][],
): boolean {
  for (const group of groups) {
    const leftHit = group.some((alias) => matchesAlias(left, alias));
    const rightHit = group.some((alias) => matchesAlias(right, alias));
    if (leftHit && rightHit) {
      return true;
    }
  }
  return false;
}

function matchesAlias(value: string, alias: string): boolean {
  if (value === alias) {
    return true;
  }
  const valueTokens = value.split(' ').filter(Boolean);
  const aliasTokens = alias.split(' ').filter(Boolean);
  if (aliasTokens.length === 1) {
    return valueTokens.includes(alias);
  }
  if (value.startsWith(`${alias} `) || value.endsWith(` ${alias}`)) {
    return true;
  }
  return value.includes(` ${alias} `);
}

function isBlacklisted(value: string): boolean {
  const normalized = normalizeComparableText(value);
  return (
    normalized === 'YES' ||
    normalized === 'Y' ||
    normalized === 'TRUE' ||
    normalized === '1' ||
    normalized === 'BLACKLISTED' ||
    normalized.includes('BLACK LIST')
  );
}

function present(value?: string | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseRcDate(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) {
    return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(trimmed);
  if (dmy) {
    return utcDate(expandYear(Number(dmy[3])), Number(dmy[2]), Number(dmy[1]));
  }

  const dMonY = /^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{2,4})$/.exec(trimmed);
  if (dMonY) {
    const month = MONTHS[dMonY[2].slice(0, 3).toUpperCase()];
    if (!month) {
      return null;
    }
    return utcDate(expandYear(Number(dMonY[3])), month, Number(dMonY[1]));
  }

  const monY = /^([A-Za-z]{3,9})[- ](\d{2,4})$/.exec(trimmed);
  if (monY) {
    const month = MONTHS[monY[1].slice(0, 3).toUpperCase()];
    if (!month) {
      return null;
    }
    return utcDate(expandYear(Number(monY[2])), month, 1);
  }

  return null;
}

function utcDate(year: number, month: number, day: number): Date | null {
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function expandYear(year: number): number {
  if (year < 100) {
    return year >= 70 ? 1900 + year : 2000 + year;
  }
  return year;
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
