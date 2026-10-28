export enum InvoiceJobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  ISSUED = 'ISSUED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

export enum InvoiceEmailStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

export enum InvoiceTaxConfigStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export enum InvoicePlaceOfSupplyMode {
  /** Place of supply is the issuer's registered state (intra-state CGST+SGST). */
  ISSUER_STATE = 'ISSUER_STATE',
  /**
   * Place of supply is the rider billing state when present.
   * Same as issuer → CGST+SGST; different → IGST. Missing rider state fails issuance.
   */
  RECIPIENT_STATE = 'RECIPIENT_STATE',
}

export enum InvoiceTaxPricingMode {
  TAX_EXCLUSIVE = 'TAX_EXCLUSIVE',
  TAX_INCLUSIVE = 'TAX_INCLUSIVE',
}

export enum InvoicePaymentStatus {
  UNPAID = 'UNPAID',
  PAID = 'PAID',
  REFUNDED = 'REFUNDED',
}

export enum InvoiceGstSplit {
  CGST_SGST = 'CGST_SGST',
  IGST = 'IGST',
}
