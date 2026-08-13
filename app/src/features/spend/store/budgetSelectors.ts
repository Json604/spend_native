export function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

export function daysRemainingInMonth(date: Date): number {
  return daysInMonth(date) - date.getDate();
}

export type PaceInput = {
  now: Date;
  budgetMinor: number | null;
  spentMinor: number;
};

export type PaceResult = {
  onPace: boolean;
  daysRemaining: number;
  remainingBudgetMinor: number;
  dailyTargetMinor: number;
};

export function computePace(input: PaceInput): PaceResult | null {
  if (input.budgetMinor == null || input.budgetMinor <= 0) {
    return null;
  }

  const totalDays = daysInMonth(input.now);
  const dayOfMonth = input.now.getDate();
  const expectedSoFar = (input.budgetMinor * dayOfMonth) / totalDays;
  const onPace = input.spentMinor <= expectedSoFar;
  const daysRemaining = totalDays - dayOfMonth;
  const remainingBudgetMinor = Math.max(input.budgetMinor - input.spentMinor, 0);
  const dailyTargetMinor =
    daysRemaining > 0 ? Math.round(remainingBudgetMinor / daysRemaining) : 0;

  return { onPace, daysRemaining, remainingBudgetMinor, dailyTargetMinor };
}

export function categoriesForMonthlyBudget<
  Category extends {id: string; parentId?: string},
>(
  categories: Category[],
  categoryBudgets: Record<string, number> | undefined,
): Category[] {
  const budgetedIds = new Set(
    Object.entries(categoryBudgets ?? {})
      .filter(([, amountMinor]) => amountMinor > 0)
      .map(([categoryId]) => categoryId),
  );
  const parentIds = new Set(
    categories
      .filter((category) => budgetedIds.has(category.id) && category.parentId)
      .map((category) => category.parentId!),
  );
  return categories.filter(
    (category) => budgetedIds.has(category.id) || parentIds.has(category.id),
  );
}
