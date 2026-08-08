import { StyleSheet, Text, View } from "react-native";
import SpendSurface from "./SpendSurface";
import { SpendCategoryPreview } from "../types/types";
import { spendCurrency } from "../store/sqliteRepository";

type SpendCategoryCardProps = {
  categories: SpendCategoryPreview[];
};

export default function SpendCategoryCard({ categories }: SpendCategoryCardProps) {
  return (
    <SpendSurface>
      <Text style={styles.title}>Categories</Text>
      <Text style={styles.subtitle}>
        Spent against your allotted budget for the month.
      </Text>

      <View style={styles.list}>
        {categories.length === 0 ? (
          <Text style={styles.empty}>
            No categories yet. Set a budget to start tracking allotments.
          </Text>
        ) : null}

        {categories.map((category, idx) => {
          const hasBudget = !!category.budgetMinor && category.budgetMinor > 0;
          const pct = Math.min(category.pct ?? 0, 1);
          const overBudget = (category.pct ?? 0) > 1;
          const depth = category.depth ?? 0;
          const isChild = depth > 0;

          return (
            <View
              key={`${category.id ?? category.label}-${idx}`}
              style={[styles.row, isChild && styles.rowChild]}
            >
              <View style={styles.labelRow}>
                <View style={[styles.dot, { backgroundColor: category.tint }]} />
                <Text style={[styles.label, isChild && styles.labelChild]}>
                  {category.label}
                </Text>
                {overBudget ? <Text style={styles.over}>Over</Text> : null}
              </View>

              <Text style={[styles.amount, isChild && styles.amountChild]}>
                {category.amountLabel}
                {hasBudget ? (
                  <Text style={styles.amountSubtle}> / {category.budgetAmountLabel}</Text>
                ) : (
                  <Text style={styles.amountSubtle}> · No budget</Text>
                )}
              </Text>

              {category.deltaMinor !== undefined && category.deltaMinor !== 0 ? (
                <Text style={styles.delta}>
                  {category.deltaMinor > 0 ? "↑" : "↓"} {spendCurrency(Math.abs(category.deltaMinor))} vs previous month
                </Text>
              ) : null}

              <View style={[styles.track, isChild && styles.trackChild]}>
                <View
                  style={[
                    styles.fill,
                    {
                      backgroundColor: overBudget ? "#FF8E72" : category.tint,
                      width: `${(hasBudget ? pct : 0) * 100}%`,
                    },
                  ]}
                />
              </View>
            </View>
          );
        })}
      </View>
    </SpendSurface>
  );
}

const styles = StyleSheet.create({
  title: {
    color: "white",
    fontSize: 20,
    fontWeight: "600",
  },
  subtitle: {
    color: "rgba(255, 255, 255, 0.62)",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
  },
  empty: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
  },
  list: {
    marginTop: 18,
    gap: 14,
  },
  row: {
    gap: 8,
  },
  rowChild: {
    paddingLeft: 18,
    opacity: 0.86,
  },
  labelChild: {
    fontSize: 13,
    color: "rgba(255,255,255,0.78)",
  },
  amountChild: {
    fontSize: 12,
  },
  trackChild: {
    height: 6,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  label: {
    color: "rgba(255, 255, 255, 0.88)",
    fontSize: 15,
    fontWeight: "500",
    flex: 1,
  },
  over: {
    color: "#FF8E72",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.6,
  },
  amount: {
    color: "rgba(255, 255, 255, 0.85)",
    fontSize: 13,
    marginLeft: 20,
  },
  amountSubtle: {
    color: "rgba(255,255,255,0.5)",
  },
  delta: { color: "rgba(255,210,122,0.72)", fontSize: 11, marginLeft: 20 },
  track: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    marginLeft: 20,
  },
  fill: {
    height: "100%",
    borderRadius: 999,
  },
});
