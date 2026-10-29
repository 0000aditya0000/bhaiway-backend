import {
  InvoiceGstSplit,
  InvoicePlaceOfSupplyMode,
  InvoiceTaxPricingMode,
} from './enums/invoice.enums';
import { INVOICE_PAISE_PER_RUPEE } from './invoice.constants';

export interface InvoiceTaxInput {
  /** Consideration in whole rupees (wallet points). Net of ride-fare coupon. */
  netFareRupees: bigint;
  /** Pre-discount ride fare in rupees. */
  grossFareRupees: bigint;
  discountRupees: bigint;
  gstRateBasisPoints: number;
  pricingMode: InvoiceTaxPricingMode;
  placeOfSupplyMode: InvoicePlaceOfSupplyMode;
  issuerStateCode: string;
  recipientStateCode: string | null;
}

export interface InvoiceTaxResult {
  taxableValuePaise: bigint;
  gstRateBasisPoints: number;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalTaxPaise: bigint;
  invoiceTotalPaise: bigint;
  split: InvoiceGstSplit;
  placeOfSupplyStateCode: string;
  pricingMode: InvoiceTaxPricingMode;
}

export class InvoiceTaxResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceTaxResolutionError';
  }
}

/** Round half-up division for non-negative GST amounts. */
export function roundPaiseHalfUp(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (denominator <= 0n) {
    throw new InvoiceTaxResolutionError('Invalid GST rounding denominator');
  }
  if (numerator < 0n) {
    throw new InvoiceTaxResolutionError('GST amounts cannot be negative');
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function rupeesToPaise(rupees: bigint): bigint {
  if (rupees < 0n) {
    throw new InvoiceTaxResolutionError('Fare amounts cannot be negative');
  }
  return rupees * INVOICE_PAISE_PER_RUPEE;
}

export function formatPaiseAsRupees(paise: bigint): string {
  const negative = paise < 0n;
  const absolute = negative ? -paise : paise;
  const rupees = absolute / INVOICE_PAISE_PER_RUPEE;
  const fraction = absolute % INVOICE_PAISE_PER_RUPEE;
  const body = `${rupees.toString()}.${fraction.toString().padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

export function indianFinancialYearLabel(issueDate: Date): string {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(issueDate);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    throw new InvoiceTaxResolutionError('Unable to resolve invoice financial year');
  }
  const startYear = month >= 4 ? year : year - 1;
  const endYear = (startYear + 1) % 100;
  return `${startYear}-${String(endYear).padStart(2, '0')}`;
}

function splitCgstSgst(totalTaxPaise: bigint): {
  cgstPaise: bigint;
  sgstPaise: bigint;
} {
  const cgstPaise = totalTaxPaise / 2n;
  return {
    cgstPaise,
    sgstPaise: totalTaxPaise - cgstPaise,
  };
}

export function resolveGstSplit(params: {
  placeOfSupplyMode: InvoicePlaceOfSupplyMode;
  issuerStateCode: string;
  recipientStateCode: string | null;
}): { split: InvoiceGstSplit; placeOfSupplyStateCode: string } {
  const issuer = params.issuerStateCode.trim();
  if (!issuer) {
    throw new InvoiceTaxResolutionError(
      'Issuer state code is required to determine GST split',
    );
  }

  if (params.placeOfSupplyMode === InvoicePlaceOfSupplyMode.ISSUER_STATE) {
    return {
      split: InvoiceGstSplit.CGST_SGST,
      placeOfSupplyStateCode: issuer,
    };
  }

  const recipient = params.recipientStateCode?.trim() ?? '';
  if (!recipient) {
    throw new InvoiceTaxResolutionError(
      'Rider billing state code is required for recipient-state place of supply',
    );
  }
  if (recipient === issuer) {
    return {
      split: InvoiceGstSplit.CGST_SGST,
      placeOfSupplyStateCode: recipient,
    };
  }
  return {
    split: InvoiceGstSplit.IGST,
    placeOfSupplyStateCode: recipient,
  };
}

/** 0% GST invoice used when no active tax rule is configured. Fare is unchanged. */
export function untaxedInvoiceResult(params: {
  netFareRupees: bigint;
  issuerStateCode: string;
}): InvoiceTaxResult {
  if (params.netFareRupees < 0n) {
    throw new InvoiceTaxResolutionError('Fare amounts cannot be negative');
  }
  const issuer = params.issuerStateCode.trim();
  if (!issuer) {
    throw new InvoiceTaxResolutionError(
      'Issuer state code is required to determine GST split',
    );
  }
  const taxableValuePaise = rupeesToPaise(params.netFareRupees);
  return {
    taxableValuePaise,
    gstRateBasisPoints: 0,
    cgstPaise: 0n,
    sgstPaise: 0n,
    igstPaise: 0n,
    totalTaxPaise: 0n,
    invoiceTotalPaise: taxableValuePaise,
    split: InvoiceGstSplit.CGST_SGST,
    placeOfSupplyStateCode: issuer,
    pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
  };
}

export function calculateInvoiceTax(input: InvoiceTaxInput): InvoiceTaxResult {
  if (input.netFareRupees < 0n || input.grossFareRupees < 0n) {
    throw new InvoiceTaxResolutionError('Fare amounts cannot be negative');
  }
  if (input.discountRupees < 0n) {
    throw new InvoiceTaxResolutionError('Discount cannot be negative');
  }
  if (input.netFareRupees + input.discountRupees !== input.grossFareRupees) {
    throw new InvoiceTaxResolutionError(
      'Gross fare must equal net fare plus discount',
    );
  }
  if (
    !Number.isInteger(input.gstRateBasisPoints) ||
    input.gstRateBasisPoints < 1 ||
    input.gstRateBasisPoints > 4000
  ) {
    throw new InvoiceTaxResolutionError('GST rate is not a valid configured value');
  }

  const considerationPaise = rupeesToPaise(input.netFareRupees);
  const rateBp = BigInt(input.gstRateBasisPoints);
  let taxableValuePaise: bigint;
  let totalTaxPaise: bigint;
  let invoiceTotalPaise: bigint;

  if (input.pricingMode === InvoiceTaxPricingMode.TAX_INCLUSIVE) {
    const divisor = 10_000n + rateBp;
    taxableValuePaise = roundPaiseHalfUp(considerationPaise * 10_000n, divisor);
    if (taxableValuePaise > considerationPaise) {
      taxableValuePaise = considerationPaise;
    }
    totalTaxPaise = considerationPaise - taxableValuePaise;
    invoiceTotalPaise = considerationPaise;
  } else {
    taxableValuePaise = considerationPaise;
    totalTaxPaise = roundPaiseHalfUp(taxableValuePaise * rateBp, 10_000n);
    invoiceTotalPaise = taxableValuePaise + totalTaxPaise;
  }

  const { split, placeOfSupplyStateCode } = resolveGstSplit({
    placeOfSupplyMode: input.placeOfSupplyMode,
    issuerStateCode: input.issuerStateCode,
    recipientStateCode: input.recipientStateCode,
  });

  let cgstPaise = 0n;
  let sgstPaise = 0n;
  let igstPaise = 0n;
  if (split === InvoiceGstSplit.IGST) {
    igstPaise = totalTaxPaise;
  } else {
    const parts = splitCgstSgst(totalTaxPaise);
    cgstPaise = parts.cgstPaise;
    sgstPaise = parts.sgstPaise;
  }

  return {
    taxableValuePaise,
    gstRateBasisPoints: input.gstRateBasisPoints,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalTaxPaise,
    invoiceTotalPaise,
    split,
    placeOfSupplyStateCode,
    pricingMode: input.pricingMode,
  };
}
