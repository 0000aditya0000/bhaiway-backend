import { CorporateEmailDomainPolicy } from './corporate-email-domain.policy';

describe('CorporateEmailDomainPolicy', () => {
  const policy = new CorporateEmailDomainPolicy();

  const blockedEmails = [
    'employee@gmail.com',
    'employee@yahoo.com',
    'employee@outlook.com',
    'employee@hotmail.com',
    'employee@live.com',
    'employee@icloud.com',
    'employee@proton.me',
    'employee@protonmail.com',
    'employee@zoho.com',
    'employee@aol.com',
    'employee@gmx.com',
    'employee@yandex.com',
    'employee@mail.com',
    'employee@mail.gmail.com',
    'employee@smtp.mail.yahoo.com',
  ];

  const allowedEmails = [
    'employee@company.com',
    'employee@tcs.com',
    'employee@kodenzolabs.in',
    'employee@startup.co',
    'employee@mail.company.com',
    'employee@evilgmail.com',
    'employee@EVILGMAIL.COM',
    'employee@notgmail.com',
  ];

  it.each(blockedEmails)('rejects personal/free email %s', (email) => {
    expect(policy.isAllowedCorporateEmail(email)).toBe(false);
  });

  it.each(allowedEmails)('allows corporate-style email %s', (email) => {
    expect(policy.isAllowedCorporateEmail(email)).toBe(true);
  });

  it('does not treat evilgmail.com as gmail.com via unsafe endsWith', () => {
    expect(policy.isBlockedDomain('evilgmail.com')).toBe(false);
    expect(policy.isBlockedDomain('gmail.com')).toBe(true);
    expect(policy.isBlockedDomain('mail.gmail.com')).toBe(true);
  });

  it('exposes the default blocked list for extension', () => {
    const domains = CorporateEmailDomainPolicy.getDefaultBlockedDomains();
    expect(domains).toContain('gmail.com');
    expect(domains).toContain('proton.me');
  });
});
