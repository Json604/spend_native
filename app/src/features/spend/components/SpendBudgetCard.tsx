import { Pressable, StyleSheet, Text, View } from "react-native";
import { computePace } from "../store/budgetSelectors";
import type { MonthlyBudget } from "../types/types";

export default function SpendBudgetCard({
  monthName,
  budget,
  spentMinor,
  onSet,
}: {
  monthName: string;
  budget: MonthlyBudget | null;
  spentMinor: number;
  onSet: () => void;
}) {
  if (!budget) {
    return (
      <Pressable onPress={onSet} style={styles.card}>
        <Text style={styles.label}>{monthName.toUpperCase()} BUDGET</Text>
        <Text style={styles.cta}>Set this month's budget</Text>
      </Pressable>
    );
  }

  const pace = computePace({
    now: new Date(),
    budgetMinor: budget.amountMinor,
    spentMinor,
  });
  const pct = Math.min(spentMinor / Math.max(budget.amountMinor, 1), 1);

  return (
    <Pressable onPress={onSet} style={styles.card}>
      <Text style={styles.label}>{monthName.toUpperCase()} BUDGET</Text>
      <View style={styles.line}>
        <Text style={styles.amt}>
          ₹{(spentMinor / 100).toLocaleString()} of ₹
          {(budget.amountMinor / 100).toLocaleString()}
        </Text>
        <Text style={styles.rem}>{pace?.daysRemaining ?? 0} days left</Text>
      </View>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${pct * 100}%` }]} />
      </View>
      {pace && pace.daysRemaining > 0 && (
        <Text style={styles.pace}>
          {pace.onPace ? "On pace" : "Over pace"} · ~₹
          {(pace.dailyTargetMinor / 100).toFixed(0)}/day to{" "}
          {pace.onPace ? "stay on track" : "recover"}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  label: { color: "#9C8B5C", fontSize: 10, letterSpacing: 1.6, fontWeight: "600" },
  cta: { color: "#FFD27A", fontSize: 16, marginTop: 10, fontWeight: "500" },
  line: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  amt: { color: "#D8CDB0", fontWeight: "500" },
  rem: { color: "#9C8B5C" },
  bar: {
    height: 5,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 3,
    marginTop: 8,
    overflow: "hidden",
  },
  barFill: { height: "100%", backgroundColor: "#E7D9A6", borderRadius: 3 },
  pace: { color: "#9C8B5C", fontSize: 11, marginTop: 8 },
});
