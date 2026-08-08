import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SpendDomainState, MonthlyBudgetMap } from "../features/spend/types/types";

const KEY_STATE = "spend.cache.state.v1";
const KEY_BUDGETS = "spend.cache.budgets.v1";

export async function readCachedState(): Promise<SpendDomainState | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_STATE);
    return raw ? (JSON.parse(raw) as SpendDomainState) : null;
  } catch {
    return null;
  }
}

export async function writeCachedState(state: SpendDomainState): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_STATE, JSON.stringify(state));
  } catch (e) {
    console.warn("cache.writeState failed", e);
  }
}

export async function readCachedBudgets(): Promise<MonthlyBudgetMap | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_BUDGETS);
    return raw ? (JSON.parse(raw) as MonthlyBudgetMap) : null;
  } catch {
    return null;
  }
}

export async function writeCachedBudgets(budgets: MonthlyBudgetMap): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_BUDGETS, JSON.stringify(budgets));
  } catch (e) {
    console.warn("cache.writeBudgets failed", e);
  }
}
