export type ParsedBudgetLine = { label: string; amountMinor: number };
export type BudgetPasteResult = { entries: ParsedBudgetLine[]; skipped: string[] };

/**
 * Turns a pasted block of text into budget lines.
 *
 * People keep budgets in notes apps long before they keep them in an app, and
 * retyping thirty categories one modal at a time is the reason a budget never
 * gets entered. Anything shaped like "<name> <amount>" is accepted, however it
 * happens to be separated:
 *
 *   Rent 15000          Groceries: 8,000      Piano = 16000
 *   Spotify ₹69         Diet coke - 1000      Travel<tab>3000
 *
 * The amount is the number at the END of the line, so names containing digits
 * ("Q1 fees 2000", "Laptop repair 2 35000") still work. Lines that do not end
 * in a number are returned as `skipped` rather than dropped silently — the user
 * gets to see what was ignored instead of discovering it later in the total.
 */
export function parseBudgetPaste(input: string): BudgetPasteResult {
  const entries: ParsedBudgetLine[] = [];
  const skipped: string[] = [];
  const seen = new Map<string, number>();

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const match = line.match(
      /^(.*?)[\s:=,|\-–—]*(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)$/i,
    );
    if (!match) {
      skipped.push(line);
      continue;
    }

    const label = match[1].replace(/\s+/g, " ").trim();
    const amount = Number(match[2].replace(/,/g, ""));
    if (label === "" || !Number.isFinite(amount)) {
      skipped.push(line);
      continue;
    }

    const amountMinor = Math.round(amount * 100);
    // A repeated name is the user correcting themselves further down the list,
    // so the last value wins rather than producing two rows for one category.
    const existing = seen.get(label.toLowerCase());
    if (existing !== undefined) {
      entries[existing] = { label, amountMinor };
      continue;
    }
    seen.set(label.toLowerCase(), entries.length);
    entries.push({ label, amountMinor });
  }

  return { entries, skipped };
}
