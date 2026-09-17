import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { CashfreeConfigService } from './cashfree.config';
import {
  CashfreeApiError,
  CashfreeRateLimitError,
} from './cashfree.errors';

export interface CashfreeVerifyVehicleRcParams {
  verificationId: string;
  vehicleNumber: string;
}

export interface CashfreeVehicleRcApiResponse {
  verificationId: string;
  referenceId?: string;
  status: 'VALID' | 'INVALID';
  regNo?: string;
  vehicleNumber?: string;
  class?: string;
  chassis?: string;
  engine?: string;
  vehicleManufacturerName?: string;
  model?: string;
  vehicleColor?: string;
  type?: string;
  normsType?: string;
  bodyType?: string;
  ownerCount?: string;
  owner?: string;
  ownerFatherName?: string;
  mobileNumber?: string;
  rcStatus?: string;
  statusAsOn?: string;
  regAuthority?: string;
  regDate?: string;
  vehicleManufacturingMonthYear?: string;
  rcExpiryDate?: string;
  vehicleTaxUpto?: string;
  vehicleInsuranceCompanyName?: string;
  vehicleInsuranceUpto?: string;
  vehicleInsurancePolicyNumber?: string;
  rcFinancer?: string;
  vehicleCategory?: string;
  seatCapacity?: number | null;
  puccNumber?: string;
  puccUpto?: string;
  blacklistStatus?: string;
  isCommercial?: boolean | null;
  failureCode?: string;
  failureReason?: string;
  sanitizedRawResponse?: Record<string, any>;
}

@Injectable()
export class CashfreeVehicleRcService {
  private readonly logger = new Logger(CashfreeVehicleRcService.name);

  constructor(private readonly configService: CashfreeConfigService) {}

  /**
   * Normalizes a vehicle registration number by removing all whitespace and hyphens
   * and converting to uppercase.
   * e.g. "dl 01-ab 1234" -> "DL01AB1234"
   */
  normalizeVehicleNumber(vehicleNumber: string): string {
    if (!vehicleNumber) return '';
    return vehicleNumber.trim().toUpperCase().replace(/[\s-]+/g, '');
  }

  /**
   * Validates verification ID format per Cashfree specifications:
   * - Alphanumeric, dot, hyphen, underscore only
   * - Maximum 50 characters
   */
  validateVerificationId(verificationId: string): void {
    if (!verificationId || typeof verificationId !== 'string') {
      throw new BadRequestException('verification_id is required');
    }
    if (verificationId.length > 50) {
      throw new BadRequestException(
        'verification_id length must not exceed 50 characters',
      );
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(verificationId)) {
      throw new BadRequestException(
        'verification_id contains invalid characters; only alphanumeric, dot, hyphen, and underscore are allowed',
      );
    }
  }

  /**
   * Verifies vehicle RC via Cashfree Vehicle RC API:
   * POST /verification/vehicle-rc
   */
  async verifyVehicleRc(
    params: CashfreeVerifyVehicleRcParams,
  ): Promise<CashfreeVehicleRcApiResponse> {
    this.validateVerificationId(params.verificationId);

    const normalizedNumber = this.normalizeVehicleNumber(params.vehicleNumber);
    if (!normalizedNumber || normalizedNumber.length < 4) {
      throw new BadRequestException('A valid vehicle_number is required');
    }

    const config = this.configService.getConfig();
    if (!config.clientId || !config.clientSecret) {
      this.logger.error('Cashfree client credentials are not configured');
      throw new CashfreeApiError('Cashfree credentials are not configured');
    }

    const url = `${config.baseUrl}/vehicle-rc`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-client-id': config.clientId,
      'x-client-secret': config.clientSecret,
    };

    const cfSignature = process.env.CASHFREE_CF_SIGNATURE?.trim();
    if (cfSignature) {
      headers['x-cf-signature'] = cfSignature;
    }

    const requestBody = {
      verification_id: params.verificationId,
      vehicle_number: normalizedNumber,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      this.logger.error(
        `Failed to reach Cashfree Vehicle RC API: ${(error as Error).message}`,
      );
      throw new CashfreeApiError(
        'Failed to communicate with Cashfree Vehicle RC service',
      );
    }

    let responseData: any = null;
    try {
      responseData = await response.json();
    } catch {
      // Non-JSON response
    }

    if (!response.ok) {
      this.handleHttpError(response.status, responseData, params.verificationId);
    }

    if (!responseData || typeof responseData !== 'object') {
      throw new CashfreeApiError('Cashfree returned invalid response format');
    }

    return this.mapToNormalizedResponse(responseData, params.verificationId);
  }

  private handleHttpError(
    statusCode: number,
    data: any,
    verificationId: string,
  ): never {
    const errorCode = data?.code || data?.subCode || data?.error || '';
    const message = data?.message || data?.description || 'Cashfree verification error';

    // 400 Bad Request
    if (statusCode === 400) {
      this.logger.warn(
        `Cashfree 400 Bad Request: code=${errorCode}, message=${message}, verificationId=${verificationId}`,
      );
      throw new BadRequestException(message || 'Invalid vehicle RC request data');
    }

    // 401 Unauthorized
    if (statusCode === 401) {
      this.logger.error(
        `Cashfree 401 Unauthorized: code=${errorCode}. Verify CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET.`,
      );
      throw new CashfreeApiError('Cashfree authentication failed');
    }

    // 403 Forbidden
    if (statusCode === 403) {
      this.logger.error(
        `Cashfree 403 Forbidden: code=${errorCode}. IP whitelist or 2FA validation failed.`,
      );
      throw new CashfreeApiError('Cashfree access forbidden (IP whitelist / 2FA)');
    }

    // 409 Conflict (Duplicate verification_id)
    if (statusCode === 409) {
      this.logger.warn(
        `Cashfree 409 Conflict: duplicate verificationId=${verificationId}`,
      );
      throw new ConflictException(message || 'Duplicate verification ID');
    }

    // 422 Unprocessable Entity
    if (statusCode === 422) {
      if (
        errorCode === 'insufficient_balance' ||
        String(message).toLowerCase().includes('balance')
      ) {
        this.logger.error('Cashfree account balance is insufficient for verification');
        throw new CashfreeApiError(
          'Cashfree service currently unavailable due to provider limits',
        );
      }
      this.logger.warn(
        `Cashfree 422 Unprocessable: code=${errorCode}, message=${message}`,
      );
      throw new BadRequestException(message || 'Vehicle RC data could not be processed');
    }

    // 429 Rate Limit
    if (statusCode === 429) {
      this.logger.warn(
        `Cashfree 429 Rate Limit: code=${errorCode}, message=${message}`,
      );
      throw new CashfreeRateLimitError(message || 'Upstream Cashfree rate limit exceeded');
    }

    // 500 Internal Server Error
    if (statusCode === 500) {
      this.logger.error(`Cashfree 500 Internal Error: message=${message}`);
      throw new CashfreeApiError('Cashfree internal server error');
    }

    // 502 / 503 / 504 Gateway errors
    this.logger.error(`Cashfree Upstream Error: status=${statusCode}, message=${message}`);
    throw new CashfreeApiError(`Cashfree upstream error (status ${statusCode})`);
  }

  private mapToNormalizedResponse(
    data: Record<string, any>,
    fallbackVerificationId: string,
  ): CashfreeVehicleRcApiResponse {
    const rawStatus = String(data.status ?? '').toUpperCase();
    const status: 'VALID' | 'INVALID' = rawStatus === 'VALID' ? 'VALID' : 'INVALID';

    const verificationId = String(data.verification_id ?? fallbackVerificationId);
    const referenceId = data.reference_id ? String(data.reference_id) : undefined;
    const regNo = data.reg_no
      ? String(data.reg_no)
      : data.vehicle_number
        ? String(data.vehicle_number)
        : undefined;

    // Mask engine & chassis for security (only keep last 4 characters visible)
    const chassis = data.chassis ? this.maskIdentifier(String(data.chassis)) : undefined;
    const engine = data.engine ? this.maskIdentifier(String(data.engine)) : undefined;

    const seatCapacity =
      data.vehicle_seat_capacity !== undefined && data.vehicle_seat_capacity !== null
        ? Number(data.vehicle_seat_capacity) || null
        : null;

    const isCommercial =
      typeof data.is_commercial === 'boolean'
        ? data.is_commercial
        : typeof data.is_commercial === 'string'
          ? data.is_commercial.toLowerCase() === 'true' || data.is_commercial === '1'
          : null;

    // Sanitize raw response to avoid logging or persisting sensitive data
    const sanitizedRawResponse = this.sanitizeResponse(data);

    return {
      verificationId,
      referenceId,
      status,
      regNo,
      vehicleNumber: regNo,
      class: data.class ? String(data.class) : undefined,
      chassis,
      engine,
      vehicleManufacturerName: data.vehicle_manufacturer_name
        ? String(data.vehicle_manufacturer_name)
        : undefined,
      model: data.model ? String(data.model) : undefined,
      vehicleColor: (data.vehicle_color || data.vehicle_colour)
        ? String(data.vehicle_color || data.vehicle_colour)
        : undefined,
      type: data.type ? String(data.type) : undefined,
      normsType: data.norms_type ? String(data.norms_type) : undefined,
      bodyType: data.body_type ? String(data.body_type) : undefined,
      ownerCount: data.owner_count ? String(data.owner_count) : undefined,
      owner: data.owner ? String(data.owner) : undefined,
      ownerFatherName: data.owner_father_name ? String(data.owner_father_name) : undefined,
      mobileNumber: data.mobile_number ? String(data.mobile_number) : undefined,
      rcStatus: data.rc_status ? String(data.rc_status) : undefined,
      statusAsOn: data.status_as_on ? String(data.status_as_on) : undefined,
      regAuthority: data.reg_authority ? String(data.reg_authority) : undefined,
      regDate: data.reg_date ? String(data.reg_date) : undefined,
      vehicleManufacturingMonthYear: data.vehicle_manufacturing_month_year
        ? String(data.vehicle_manufacturing_month_year)
        : undefined,
      rcExpiryDate: data.rc_expiry_date ? String(data.rc_expiry_date) : undefined,
      vehicleTaxUpto: data.vehicle_tax_upto ? String(data.vehicle_tax_upto) : undefined,
      vehicleInsuranceCompanyName: data.vehicle_insurance_company_name
        ? String(data.vehicle_insurance_company_name)
        : undefined,
      vehicleInsuranceUpto: data.vehicle_insurance_upto
        ? String(data.vehicle_insurance_upto)
        : undefined,
      vehicleInsurancePolicyNumber: data.vehicle_insurance_policy_number
        ? String(data.vehicle_insurance_policy_number)
        : undefined,
      rcFinancer: data.rc_financer ? String(data.rc_financer) : undefined,
      vehicleCategory: data.vehicle_category ? String(data.vehicle_category) : undefined,
      seatCapacity,
      puccNumber: data.pucc_number ? String(data.pucc_number) : undefined,
      puccUpto: data.pucc_upto ? String(data.pucc_upto) : undefined,
      blacklistStatus: data.blacklist_status ? String(data.blacklist_status) : undefined,
      isCommercial,
      failureCode: status === 'INVALID' ? (data.code || 'VEHICLE_RC_INVALID') : undefined,
      failureReason: status === 'INVALID' ? (data.message || 'Vehicle RC is invalid') : undefined,
      sanitizedRawResponse,
    };
  }

  private maskIdentifier(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length <= 4) return trimmed;
    const visible = trimmed.slice(-4);
    return `${'*'.repeat(trimmed.length - 4)}${visible}`;
  }

  private sanitizeResponse(raw: Record<string, any>): Record<string, any> {
    const cloned = { ...raw };
    // Remove sensitive client credentials if ever returned or passed
    delete cloned['x-client-id'];
    delete cloned['x-client-secret'];
    delete cloned['client_secret'];
    delete cloned['secret'];
    // Redact sensitive personal details not needed operationally
    delete cloned['present_address'];
    delete cloned['split_present_address'];
    delete cloned['permanent_address'];
    delete cloned['split_permanent_address'];
    delete cloned['mobile_number'];
    delete cloned['owner_father_name'];
    return cloned;
  }
}
