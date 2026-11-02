/**
 * Calculates response due date based on Indian business days (default: 7 business days).
 *
 * Rules:
 * - Excludes weekends (Saturdays and Sundays).
 * - Excludes standard configured Indian statutory public holidays (Republic Day, Independence Day, Gandhi Jayanti).
 * - Documented: Holiday calendar is extensible via additional configured dates.
 */
export const INDIA_FIXED_PUBLIC_HOLIDAYS_MM_DD: readonly string[] = [
  '01-26', // Republic Day
  '08-15', // Independence Day
  '10-02', // Gandhi Jayanti
];

export function calculateIndiaBusinessDays(
  startDate: Date,
  businessDays = 7,
  extraHolidays: readonly string[] = [],
): Date {
  const result = new Date(startDate);
  let daysAdded = 0;

  const holidaySet = new Set([
    ...INDIA_FIXED_PUBLIC_HOLIDAYS_MM_DD,
    ...extraHolidays,
  ]);

  while (daysAdded < businessDays) {
    result.setDate(result.getDate() + 1);
    const dayOfWeek = result.getDay(); // 0 is Sunday, 6 is Saturday

    if (dayOfWeek === 0 || dayOfWeek === 6) {
      continue;
    }

    const month = String(result.getMonth() + 1).padStart(2, '0');
    const day = String(result.getDate()).padStart(2, '0');
    const mmDd = `${month}-${day}`;

    if (holidaySet.has(mmDd)) {
      continue;
    }

    daysAdded++;
  }

  return result;
}
