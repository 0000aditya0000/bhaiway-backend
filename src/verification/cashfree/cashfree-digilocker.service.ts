import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

import { CashfreeConfigService } from './cashfree.config';
import {
  CashfreeApiError,
  CashfreeWebhookSignatureError,
  CashfreeWebhookTimestampError,
} from './cashfree.errors';

export interface CashfreeCreateSessionParams {
  verificationId: string;
  redirectUrl?: string;
  userFlow?: string;
}

export interface CashfreeCreateSessionResponse {
  verificationId: string;
  referenceId: string;
  url: string;
  status: string;
  documentRequested?: string[];
  redirectUrl?: string;
}

export interface CashfreeGetStatusResponse {
  status: string;
  referenceId?: string;
  verificationId?: string;
  userDetails?: {
    name?: string;
    dob?: string;
    gender?: string;
    mobile?: string;
  } | null;
  documentRequested?: string[];
  documentConsent?: boolean;
  documentConsentValidity?: string;
  rawStatus?: string;
}

export interface CashfreeAadhaarDocumentResponse {
  status: string;
  uid?: string;
  name?: string;
  dob?: string;
  gender?: string;
  mobile?: string;
  photoLink?: string;
  yearOfBirth?: string;
}

@Injectable()
export class CashfreeDigiLockerService {
  private readonly logger = new Logger(CashfreeDigiLockerService.name);

  constructor(private readonly configService: CashfreeConfigService) {}

  /**
   * Create DigiLocker verification session via Cashfree V2 API:
   * POST /verification/digilocker
   */
  async createVerificationUrl(
    params: CashfreeCreateSessionParams,
  ): Promise<CashfreeCreateSessionResponse> {
    const config = this.configService.getConfig();
    const url = `${config.baseUrl}/digilocker`;
    const redirectUrl = params.redirectUrl ?? config.redirectUrl;

    this.logger.log(
      '[CashfreeDigiLockerService] Using Cashfree verification environment: production',
    );
    this.logger.log(
      `[CashfreeDigiLockerService] DigiLocker endpoint: ${url}`,
    );

    const requestBody = {
      verification_id: params.verificationId,
      document_requested: ['AADHAAR'],
      redirect_url: redirectUrl,
      user_flow: params.userFlow ?? 'signin',
    };

    const response = await this.executeHttpRequest(url, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const data = response as Record<string, any>;
    const verificationId = String(data.verification_id ?? params.verificationId);
    const referenceId = String(data.reference_id ?? '');
    const digilockerUrl = String(data.url ?? '');
    const status = String(data.status ?? 'PENDING');

    if (!digilockerUrl) {
      throw new CashfreeApiError('Cashfree did not return a valid DigiLocker URL');
    }

    return {
      verificationId,
      referenceId,
      url: digilockerUrl,
      status,
      documentRequested: Array.isArray(data.document_requested)
        ? data.document_requested
        : ['AADHAAR'],
      redirectUrl: data.redirect_url ? String(data.redirect_url) : redirectUrl,
    };
  }

  /**
   * Query status of DigiLocker verification session:
   * GET /verification/digilocker
   */
  async getVerificationStatus(identifier: {
    referenceId?: string | null;
    verificationId?: string | null;
  }): Promise<CashfreeGetStatusResponse> {
    const config = this.configService.getConfig();
    const query = new URLSearchParams();
    if (identifier.referenceId) {
      query.set('reference_id', identifier.referenceId);
    } else if (identifier.verificationId) {
      query.set('verification_id', identifier.verificationId);
    } else {
      throw new CashfreeApiError('Either referenceId or verificationId must be provided');
    }

    const url = `${config.baseUrl}/digilocker?${query.toString()}`;
    const response = (await this.executeHttpRequest(url, {
      method: 'GET',
    })) as Record<string, any>;

    const status = String(response.status ?? 'PENDING');
    const userDetails = response.user_details ?? response.user_data;

    return {
      status,
      referenceId: response.reference_id ? String(response.reference_id) : undefined,
      verificationId: response.verification_id
        ? String(response.verification_id)
        : undefined,
      userDetails: userDetails
        ? {
            name: userDetails.name ? String(userDetails.name) : undefined,
            dob: userDetails.dob ? String(userDetails.dob) : undefined,
            gender: userDetails.gender ? String(userDetails.gender) : undefined,
            mobile: userDetails.mobile ? String(userDetails.mobile) : undefined,
          }
        : null,
      documentRequested: Array.isArray(response.document_requested)
        ? response.document_requested
        : undefined,
      documentConsent:
        typeof response.document_consent === 'boolean'
          ? response.document_consent
          : undefined,
      documentConsentValidity: response.document_consent_validity
        ? String(response.document_consent_validity)
        : undefined,
      rawStatus: status,
    };
  }

  /**
   * Retrieve verified Aadhaar document:
   * GET /verification/digilocker/document/AADHAAR
   */
  async getAadhaarDocument(identifier: {
    referenceId?: string | null;
    verificationId?: string | null;
  }): Promise<CashfreeAadhaarDocumentResponse> {
    const config = this.configService.getConfig();
    const query = new URLSearchParams();
    if (identifier.referenceId) {
      query.set('reference_id', identifier.referenceId);
    } else if (identifier.verificationId) {
      query.set('verification_id', identifier.verificationId);
    } else {
      throw new CashfreeApiError('Either referenceId or verificationId must be provided');
    }

    const url = `${config.baseUrl}/digilocker/document/AADHAAR?${query.toString()}`;
    const response = (await this.executeHttpRequest(url, {
      method: 'GET',
    })) as Record<string, any>;

    return {
      status: String(response.status ?? 'VALID'),
      uid: response.uid ? String(response.uid) : undefined,
      name: response.name ? String(response.name) : undefined,
      dob: response.dob ? String(response.dob) : undefined,
      gender: response.gender ? String(response.gender) : undefined,
      mobile: response.mobile ? String(response.mobile) : undefined,
      photoLink: response.photo_link ? String(response.photo_link) : undefined,
      yearOfBirth: response.year_of_birth ? String(response.year_of_birth) : undefined,
    };
  }

  /**
   * Verifies HMAC-SHA256 webhook signature against raw request body.
   * Signature calculation:
   *   signatureData = timestamp + rawBody
   *   HMAC-SHA256 using CASHFREE_CLIENT_SECRET -> Base64
   */
  verifyWebhookSignature(
    rawBody: Buffer,
    signature: string,
    timestamp: string,
  ): boolean {
    if (!signature || !timestamp || !rawBody) {
      return false;
    }

    const config = this.configService.getConfig();
    if (!config.clientSecret) {
      this.logger.error(
        'CRITICAL: Cashfree client secret is not configured in environment! Check CASHFREE_CLIENT_SECRET in Render environment variables.',
      );
      return false;
    }

    try {
      const trimmedSignature = signature.trim();

      // Check all valid permutations generated with config.clientSecret
      const candidates = [
        // 1. timestamp + rawBody (standard Cashfree webhook signature)
        (() => {
          const h = crypto.createHmac('sha256', config.clientSecret);
          h.update(timestamp);
          h.update(rawBody);
          return h.digest('base64');
        })(),
        // 2. timestamp + "." + rawBody
        (() => {
          const h = crypto.createHmac('sha256', config.clientSecret);
          h.update(`${timestamp}.`);
          h.update(rawBody);
          return h.digest('base64');
        })(),
        // 3. rawBody only
        (() => {
          const h = crypto.createHmac('sha256', config.clientSecret);
          h.update(rawBody);
          return h.digest('base64');
        })(),
      ];

      const providedBuffer = Buffer.from(trimmedSignature, 'utf8');

      for (const computedSignature of candidates) {
        const expectedBuffer = Buffer.from(computedSignature, 'utf8');
        if (
          expectedBuffer.length === providedBuffer.length &&
          crypto.timingSafeEqual(expectedBuffer, providedBuffer)
        ) {
          return true;
        }
      }

      this.logger.warn(
        `Webhook HMAC mismatch: receivedSignature=${trimmedSignature.slice(0, 10)}... (length=${trimmedSignature.length}), timestamp=${timestamp}, rawBodyLength=${rawBody.length}. Verify CASHFREE_CLIENT_SECRET matches the Cashfree environment.`,
      );
      return false;
    } catch (error) {
      this.logger.error(`Webhook signature verification error: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Replay protection: verifies that the webhook timestamp is within 5 minutes.
   */
  validateWebhookTimestamp(timestampStr: string, windowSeconds = 300): void {
    if (!timestampStr) {
      throw new CashfreeWebhookTimestampError('Missing webhook timestamp');
    }

    let timestampMs: number;
    if (/^\d+$/.test(timestampStr)) {
      const numeric = Number(timestampStr);
      // Support epoch seconds (10 digits) vs epoch ms (13 digits)
      timestampMs = timestampStr.length <= 10 ? numeric * 1000 : numeric;
    } else {
      timestampMs = Date.parse(timestampStr);
    }

    if (isNaN(timestampMs)) {
      throw new CashfreeWebhookTimestampError('Malformed webhook timestamp format');
    }

    const now = Date.now();
    const deltaMs = Math.abs(now - timestampMs);
    const maxDeltaMs = windowSeconds * 1000;

    if (deltaMs > maxDeltaMs) {
      throw new CashfreeWebhookTimestampError(
        `Webhook timestamp expired (age ${Math.round(deltaMs / 1000)}s exceeds ${windowSeconds}s window)`,
      );
    }
  }

  private async executeHttpRequest(
    url: string,
    options: {
      method: 'GET' | 'POST';
      body?: string;
    },
  ): Promise<unknown> {
    const config = this.configService.getConfig();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-client-id': config.clientId,
      'x-client-secret': config.clientSecret,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      this.logger.error(`Cashfree HTTP request error: ${(error as Error).message}`);
      throw new CashfreeApiError('Failed to communicate with Cashfree DigiLocker service');
    }

    if (!response.ok) {
      let errorBody: string = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore
      }
      this.logger.warn(`Cashfree rejected request: status=${response.status} url=${url}`);
      throw new CashfreeApiError(
        `Cashfree DigiLocker API rejected request with status ${response.status}`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new CashfreeApiError('Cashfree returned non-JSON response');
    }
  }
}
