/**
 * Centralized personal/free-email domain blocklist for Corporate Identity
 * Verification. Additional providers should be added here only.
 *
 * Matching respects DNS label boundaries: `mail.gmail.com` is blocked as a
 * subdomain of `gmail.com`, but `evilgmail.com` is not.
 */
const BLOCKED_PERSONAL_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'aol.com',
  'gmx.com',
  'yandex.com',
  'mail.com',
] as const;

export class CorporateEmailDomainPolicy {
  private readonly blockedDomains: ReadonlySet<string>;

  constructor(blockedDomains: readonly string[] = BLOCKED_PERSONAL_EMAIL_DOMAINS) {
    this.blockedDomains = new Set(
      blockedDomains.map((domain) => domain.trim().toLowerCase()),
    );
  }

  /** Returns the initial blocked provider list (for tests / docs). */
  static getDefaultBlockedDomains(): readonly string[] {
    return BLOCKED_PERSONAL_EMAIL_DOMAINS;
  }

  extractDomain(email: string): string | null {
    const at = email.lastIndexOf('@');
    if (at <= 0 || at === email.length - 1) {
      return null;
    }
    const domain = email.slice(at + 1).trim().toLowerCase();
    if (!domain || domain.includes(' ') || domain.includes('@')) {
      return null;
    }
    return domain;
  }

  isBlockedDomain(domain: string): boolean {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    for (const blocked of this.blockedDomains) {
      if (this.domainMatchesOrIsSubdomainOf(normalized, blocked)) {
        return true;
      }
    }
    return false;
  }

  isAllowedCorporateEmail(email: string): boolean {
    const domain = this.extractDomain(email);
    if (!domain) {
      return false;
    }
    return !this.isBlockedDomain(domain);
  }

  /**
   * True when `candidate` equals `blocked` or is a DNS subdomain of it
   * (label-boundary aware). Does NOT treat `evilgmail.com` as `gmail.com`.
   */
  private domainMatchesOrIsSubdomainOf(
    candidate: string,
    blocked: string,
  ): boolean {
    if (candidate === blocked) {
      return true;
    }
    return candidate.endsWith(`.${blocked}`);
  }
}
