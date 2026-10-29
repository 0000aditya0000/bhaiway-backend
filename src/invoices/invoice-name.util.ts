export function formatPersonName(profile: {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
} | null | undefined): string | null {
  if (!profile) {
    return null;
  }
  const display = profile.displayName?.trim();
  if (display) {
    return display;
  }
  const parts = [profile.firstName, profile.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' ') : null;
}

export function formatIssuerAddress(input: {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  stateCode: string;
  pinCode: string;
}): string {
  const lines = [
    input.addressLine1.trim(),
    input.addressLine2?.trim() || null,
    `${input.city.trim()}, ${input.state.trim()} ${input.stateCode.trim()}`,
    `PIN ${input.pinCode.trim()}`,
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

/** Filesystem-safe PDF name from the invoice number (slashes cannot appear in filenames). */
export function invoicePdfFilename(invoiceNumber: string): string {
  const stem = invoiceNumber
    .trim()
    .replace(/[/\\]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '');
  return `${stem || 'invoice'}.pdf`;
}

export function rideDepartureAt(ride: {
  departureDate?: string | null;
  departureTime?: string | null;
}): Date | null {
  if (!ride.departureDate || !ride.departureTime) {
    return null;
  }
  const time = String(ride.departureTime).slice(0, 8);
  const normalized = time.length === 5 ? `${time}:00` : time;
  const parsed = new Date(`${ride.departureDate}T${normalized}+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
