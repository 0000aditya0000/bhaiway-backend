import { VehicleType } from './enums/vehicle-type.enum';
import {
  evaluateVehicleRcChecks,
  FieldCheckStatus,
  normalizeRegistrationNumber,
  parseRcDate,
  RC_ERROR_CODES,
} from './vehicle-rc-matching';
import type { CashfreeVehicleRcApiResponse } from '../verification/cashfree/cashfree-vehicle-rc.service';

describe('vehicle-rc-matching', () => {
  const vehicle = {
    registrationNumber: 'UP16AB1234',
    make: 'Hyundai',
    model: 'i20',
    color: 'White',
    vehicleType: VehicleType.CAR,
  };

  function provider(
    overrides: Partial<CashfreeVehicleRcApiResponse> = {},
  ): CashfreeVehicleRcApiResponse {
    return {
      verificationId: 'rc_unit',
      status: 'VALID',
      regNo: 'UP16AB1234',
      vehicleManufacturerName: 'HYUNDAI MOTOR INDIA',
      model: 'I20 ASTA',
      vehicleColor: 'WHITE',
      class: 'Motor Car (LMV)',
      rcStatus: 'ACTIVE',
      vehicleInsuranceUpto: '2099-12-31',
      ...overrides,
    };
  }

  it('normalizes registration numbers by case, spaces, and hyphens', () => {
    expect(normalizeRegistrationNumber(' up 16-ab 1234 ')).toBe('UP16AB1234');
  });

  it('parses common RC date formats', () => {
    expect(parseRcDate('2099-12-31')?.toISOString().slice(0, 10)).toBe(
      '2099-12-31',
    );
    expect(parseRcDate('31-Mar-2025')?.toISOString().slice(0, 10)).toBe(
      '2025-03-31',
    );
    expect(parseRcDate('31/03/2025')?.toISOString().slice(0, 10)).toBe(
      '2025-03-31',
    );
  });

  it('matches make/model/colour despite provider formatting and aliases', () => {
    const result = evaluateVehicleRcChecks(vehicle, provider());
    expect(result.passed).toBe(true);
    expect(result.checks.registrationNumber.status).toBe(
      FieldCheckStatus.MATCHED,
    );
    expect(result.checks.make.status).toBe(FieldCheckStatus.MATCHED);
    expect(result.checks.model.status).toBe(FieldCheckStatus.MATCHED);
    expect(result.checks.colour.status).toBe(FieldCheckStatus.MATCHED);
    expect(result.checks.vehicleType.status).toBe(FieldCheckStatus.MATCHED);
    expect(result.checks.insurance.status).toBe(FieldCheckStatus.MATCHED);
  });

  it('reports a registration number mismatch', () => {
    const result = evaluateVehicleRcChecks(
      vehicle,
      provider({ regNo: 'DL8CAB5678' }),
    );
    expect(result.passed).toBe(false);
    expect(result.primaryCode).toBe(RC_ERROR_CODES.VEHICLE_NUMBER_MISMATCH);
    expect(result.checks.registrationNumber.status).toBe(
      FieldCheckStatus.MISMATCHED,
    );
  });

  it('reports a vehicle name/model mismatch', () => {
    const result = evaluateVehicleRcChecks(
      vehicle,
      provider({ model: 'Grand i10' }),
    );
    expect(result.passed).toBe(false);
    expect(result.primaryCode).toBe(RC_ERROR_CODES.VEHICLE_DETAILS_MISMATCH);
    expect(result.checks.model.status).toBe(FieldCheckStatus.MISMATCHED);
    expect(result.checks.vehicleName.status).toBe(FieldCheckStatus.MISMATCHED);
    expect(result.errors[0].field).toBe('model');
  });

  it('reports a colour mismatch when both values are present', () => {
    const result = evaluateVehicleRcChecks(
      vehicle,
      provider({ vehicleColor: 'Black' }),
    );
    expect(result.passed).toBe(false);
    expect(result.checks.colour.status).toBe(FieldCheckStatus.MISMATCHED);
    expect(result.errors.some((error) => error.field === 'colour')).toBe(true);
  });

  it('fails expired insurance with INSURANCE_EXPIRED', () => {
    const result = evaluateVehicleRcChecks(
      vehicle,
      provider({ vehicleInsuranceUpto: '2020-01-01' }),
    );
    expect(result.passed).toBe(false);
    expect(result.primaryCode).toBe(RC_ERROR_CODES.INSURANCE_EXPIRED);
    expect(result.checks.insurance.status).toBe(FieldCheckStatus.MISMATCHED);
  });

  it('fails explicit invalid insurance', () => {
    const result = evaluateVehicleRcChecks(
      vehicle,
      provider({ vehicleInsuranceUpto: 'EXPIRED' }),
    );
    expect(result.passed).toBe(false);
    expect(result.primaryCode).toBe(RC_ERROR_CODES.INSURANCE_INVALID);
  });

  it('fails when insurance details are unavailable', () => {
    const result = evaluateVehicleRcChecks(
      vehicle,
      provider({ vehicleInsuranceUpto: undefined }),
    );
    expect(result.passed).toBe(false);
    expect(result.primaryCode).toBe(
      RC_ERROR_CODES.INSURANCE_DETAILS_UNAVAILABLE,
    );
    expect(result.checks.insurance.status).toBe(FieldCheckStatus.NOT_AVAILABLE);
  });

  it('fails invalid vehicle registration status', () => {
    const result = evaluateVehicleRcChecks(
      vehicle,
      provider({ rcStatus: 'EXPIRED' }),
    );
    expect(result.passed).toBe(false);
    expect(result.primaryCode).toBe(RC_ERROR_CODES.VEHICLE_STATUS_INVALID);
  });

  it('does not treat missing provider identity fields as a match', () => {
    const result = evaluateVehicleRcChecks(
      vehicle,
      provider({
        vehicleManufacturerName: undefined,
        model: undefined,
        vehicleColor: undefined,
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.checks.vehicleName.status).toBe(
      FieldCheckStatus.NOT_AVAILABLE,
    );
    expect(result.checks.colour.status).toBe(FieldCheckStatus.NOT_AVAILABLE);
    expect(
      result.errors.some(
        (error) => error.code === RC_ERROR_CODES.VEHICLE_DETAILS_MISMATCH,
      ),
    ).toBe(true);
  });

  it('does not mark INVALID Cashfree status as verified', () => {
    const result = evaluateVehicleRcChecks(
      vehicle,
      provider({
        status: 'INVALID',
        failureReason: 'RC details not found in registry',
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.primaryCode).toBe(RC_ERROR_CODES.VEHICLE_RC_INVALID);
    expect(result.verificationStatus).toBe('FAILED');
  });
});
