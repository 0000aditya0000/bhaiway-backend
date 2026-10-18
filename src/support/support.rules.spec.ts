import {
  SUPPORT_CATEGORY_SUBCATEGORIES,
  SUPPORT_STATUS_TRANSITIONS,
  SupportTicketCategory,
  SupportTicketStatus,
} from './enums/support.enums';

describe('Support ticket rules', () => {
  it('defines subcategories for all three categories', () => {
    expect(
      SUPPORT_CATEGORY_SUBCATEGORIES[SupportTicketCategory.BOOKINGS_AND_RIDES],
    ).toContain('DRIVER_BEHAVIOUR');
    expect(
      SUPPORT_CATEGORY_SUBCATEGORIES[
        SupportTicketCategory.PAYMENTS_AND_WALLETS
      ],
    ).toContain('WITHDRAWAL_ISSUE');
    expect(
      SUPPORT_CATEGORY_SUBCATEGORIES[SupportTicketCategory.OTHERS],
    ).toContain('SUGGESTION');
  });

  it('allows CREATED → IN_PROGRESS|RESOLVED and IN_PROGRESS → RESOLVED only', () => {
    expect(SUPPORT_STATUS_TRANSITIONS[SupportTicketStatus.CREATED]).toEqual([
      SupportTicketStatus.IN_PROGRESS,
      SupportTicketStatus.RESOLVED,
    ]);
    expect(SUPPORT_STATUS_TRANSITIONS[SupportTicketStatus.IN_PROGRESS]).toEqual(
      [SupportTicketStatus.RESOLVED],
    );
    expect(SUPPORT_STATUS_TRANSITIONS[SupportTicketStatus.RESOLVED]).toEqual(
      [],
    );
  });

  it('rejects cross-category subcategories', () => {
    const bookings =
      SUPPORT_CATEGORY_SUBCATEGORIES[SupportTicketCategory.BOOKINGS_AND_RIDES];
    expect(bookings.includes('WALLET_ISSUE')).toBe(false);
    expect(bookings.includes('ACCOUNT_ISSUE')).toBe(false);
  });
});
