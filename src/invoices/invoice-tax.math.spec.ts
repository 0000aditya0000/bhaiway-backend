import {
  InvoiceGstSplit,
  InvoicePlaceOfSupplyMode,
  InvoiceTaxPricingMode,
} from './enums/invoice.enums';
import {
  calculateInvoiceTax,
  formatPaiseAsRupees,
  indianFinancialYearLabel,
  InvoiceTaxResolutionError,
  roundPaiseHalfUp,
} from './invoice-tax.math';

describe('invoice tax math', () => {
  it('rounds GST paise half-up', () => {
    expect(roundPaiseHalfUp(15n, 10n)).toBe(2n);
    expect(roundPaiseHalfUp(14n, 10n)).toBe(1n);
  });

  it('formats paise as rupees', () => {
    expect(formatPaiseAsRupees(11050n)).toBe('110.50');
    expect(formatPaiseAsRupees(0n)).toBe('0.00');
  });

  it('uses Indian financial year in Asia/Kolkata', () => {
    expect(indianFinancialYearLabel(new Date('2026-03-31T18:31:00.000Z'))).toBe(
      '2026-27',
    );
    expect(indianFinancialYearLabel(new Date('2026-03-31T18:29:00.000Z'))).toBe(
      '2025-26',
    );
  });

  it('calculates tax-exclusive CGST/SGST for issuer-state place of supply', () => {
    const result = calculateInvoiceTax({
      netFareRupees: 1000n,
      grossFareRupees: 1100n,
      discountRupees: 100n,
      gstRateBasisPoints: 1800,
      pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
      placeOfSupplyMode: InvoicePlaceOfSupplyMode.ISSUER_STATE,
      issuerStateCode: '27',
      recipientStateCode: '07',
    });
    expect(result.taxableValuePaise).toBe(100000n);
    expect(result.totalTaxPaise).toBe(18000n);
    expect(result.invoiceTotalPaise).toBe(118000n);
    expect(result.split).toBe(InvoiceGstSplit.CGST_SGST);
    expect(result.cgstPaise + result.sgstPaise).toBe(18000n);
    expect(result.igstPaise).toBe(0n);
    expect(result.placeOfSupplyStateCode).toBe('27');
  });

  it('calculates tax-inclusive amounts without changing consideration', () => {
    const result = calculateInvoiceTax({
      netFareRupees: 118n,
      grossFareRupees: 118n,
      discountRupees: 0n,
      gstRateBasisPoints: 1800,
      pricingMode: InvoiceTaxPricingMode.TAX_INCLUSIVE,
      placeOfSupplyMode: InvoicePlaceOfSupplyMode.ISSUER_STATE,
      issuerStateCode: '27',
      recipientStateCode: null,
    });
    expect(result.invoiceTotalPaise).toBe(11800n);
    expect(result.taxableValuePaise + result.totalTaxPaise).toBe(11800n);
    expect(result.taxableValuePaise).toBe(10000n);
    expect(result.totalTaxPaise).toBe(1800n);
  });

  it('selects IGST when recipient-state place of supply differs from issuer', () => {
    const result = calculateInvoiceTax({
      netFareRupees: 200n,
      grossFareRupees: 200n,
      discountRupees: 0n,
      gstRateBasisPoints: 500,
      pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
      placeOfSupplyMode: InvoicePlaceOfSupplyMode.RECIPIENT_STATE,
      issuerStateCode: '27',
      recipientStateCode: '07',
    });
    expect(result.split).toBe(InvoiceGstSplit.IGST);
    expect(result.igstPaise).toBe(1000n);
    expect(result.cgstPaise).toBe(0n);
    expect(result.placeOfSupplyStateCode).toBe('07');
  });

  it('selects CGST/SGST when recipient state matches issuer', () => {
    const result = calculateInvoiceTax({
      netFareRupees: 200n,
      grossFareRupees: 200n,
      discountRupees: 0n,
      gstRateBasisPoints: 500,
      pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
      placeOfSupplyMode: InvoicePlaceOfSupplyMode.RECIPIENT_STATE,
      issuerStateCode: '27',
      recipientStateCode: '27',
    });
    expect(result.split).toBe(InvoiceGstSplit.CGST_SGST);
    expect(result.igstPaise).toBe(0n);
  });

  it('rejects missing recipient state and fare mismatches', () => {
    expect(() =>
      calculateInvoiceTax({
        netFareRupees: 100n,
        grossFareRupees: 100n,
        discountRupees: 0n,
        gstRateBasisPoints: 1800,
        pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
        placeOfSupplyMode: InvoicePlaceOfSupplyMode.RECIPIENT_STATE,
        issuerStateCode: '27',
        recipientStateCode: null,
      }),
    ).toThrow(InvoiceTaxResolutionError);

    expect(() =>
      calculateInvoiceTax({
        netFareRupees: 80n,
        grossFareRupees: 100n,
        discountRupees: 10n,
        gstRateBasisPoints: 1800,
        pricingMode: InvoiceTaxPricingMode.TAX_EXCLUSIVE,
        placeOfSupplyMode: InvoicePlaceOfSupplyMode.ISSUER_STATE,
        issuerStateCode: '27',
        recipientStateCode: null,
      }),
    ).toThrow(/Gross fare must equal net fare plus discount/);
  });
});
