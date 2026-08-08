import type { CategoryBudgetMap, MonthlyBudget, MonthlyBudgetMap } from "../types/types";

export type BudgetStore = {
  getBudget: (monthKey: string) => MonthlyBudget | null;
  setBudget: (monthKey: string, categoryBudgets: CategoryBudgetMap) => MonthlyBudget;
  clearBudget: (monthKey: string) => void;
  getAll: () => MonthlyBudgetMap;
  replaceAll: (map: MonthlyBudgetMap) => void;
};

export function monthKeyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function sumBudget(map: CategoryBudgetMap): number {
  return Object.values(map).reduce((acc, v) => acc + (v > 0 ? v : 0), 0);
}

function sanitize(map: CategoryBudgetMap): CategoryBudgetMap {
  const out: CategoryBudgetMap = {};
  for (const [k, v] of Object.entries(map)) {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

function buildEntry(monthKey: string, categoryBudgets: CategoryBudgetMap): MonthlyBudget {
  const clean = sanitize(categoryBudgets);
  return {
    monthKey,
    amountMinor: sumBudget(clean),
    categoryBudgets: clean,
    setAt: new Date().toISOString(),
  };
}

function normalizeStored(raw: unknown, fallbackKey: string): MonthlyBudget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MonthlyBudget> & { amountMinor?: number };
  const monthKey = typeof r.monthKey === "string" ? r.monthKey : fallbackKey;
  const setAt = typeof r.setAt === "string" ? r.setAt : new Date().toISOString();
  const categoryBudgets =
    r.categoryBudgets && typeof r.categoryBudgets === "object"
      ? sanitize(r.categoryBudgets as CategoryBudgetMap)
      : {};
  const amountMinor =
    Object.keys(categoryBudgets).length > 0
      ? sumBudget(categoryBudgets)
      : Math.max(0, Math.round(Number(r.amountMinor) || 0));
  return { monthKey, amountMinor, categoryBudgets, setAt };
}

function normalizeMap(raw: unknown): MonthlyBudgetMap {
  if (!raw || typeof raw !== "object") return {};
  const out: MonthlyBudgetMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = normalizeStored(value, key);
    if (entry) out[key] = entry;
  }
  return out;
}

export function createInMemoryBudgetStore(initial: MonthlyBudgetMap = {}): BudgetStore {
  let map: MonthlyBudgetMap = normalizeMap(initial);

  return {
    getBudget(monthKey) {
      return map[monthKey] ?? null;
    },
    setBudget(monthKey, categoryBudgets) {
      const entry = buildEntry(monthKey, categoryBudgets);
      map = { ...map, [monthKey]: entry };
      return entry;
    },
    clearBudget(monthKey) {
      const next = { ...map };
      delete next[monthKey];
      map = next;
    },
    getAll() {
      return { ...map };
    },
    replaceAll(newMap) {
      map = normalizeMap(newMap);
    },
  };
}
