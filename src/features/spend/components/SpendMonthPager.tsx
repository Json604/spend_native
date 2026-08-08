import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons";
import { accountingMonthKey, spendMonthLabel } from "../store/sqliteRepository";

type SpendMonthPagerProps = {
  monthKey: string;
  months: string[];
  onSelect: (monthKey: string) => void;
};

/**
 * A dropdown rather than a horizontal strip: the strip put future months one
 * swipe away, and a month that has not happened yet can only ever be empty.
 * Options are filtered to the current accounting month and earlier, newest
 * first, so "look at a previous month" is the only thing this control does.
 */
export default function SpendMonthPager({ monthKey, months, onSelect }: SpendMonthPagerProps) {
  const [open, setOpen] = useState(false);
  const current = accountingMonthKey();

  const selectable = useMemo(() => {
    const unique = new Set(months.filter((month) => month <= current));
    unique.add(current);
    if (monthKey <= current) unique.add(monthKey);
    return Array.from(unique).sort().reverse();
  }, [months, current, monthKey]);

  const choose = (month: string) => {
    setOpen(false);
    if (month !== monthKey) onSelect(month);
  };

  return (
    <View style={styles.wrapper}>
      <Pressable
        onPress={() => setOpen(true)}
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel={`Month: ${spendMonthLabel(monthKey)}. Tap to change.`}
      >
        <View style={styles.dot} />
        <Text style={styles.triggerLabel}>{spendMonthLabel(monthKey)}</Text>
        <MaterialCommunityIcons name="chevron-down" size={18} color="#C9B98C" />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
            <Text style={styles.sheetTitle}>Choose month</Text>
            <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
              {selectable.map((month) => {
                const active = month === monthKey;
                return (
                  <Pressable
                    key={month}
                    onPress={() => choose(month)}
                    style={[styles.option, active && styles.optionActive]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.optionLabel, active && styles.optionLabelActive]}>
                      {spendMonthLabel(month)}
                    </Text>
                    {month === current ? <Text style={styles.badge}>THIS MONTH</Text> : null}
                    {active ? <MaterialCommunityIcons name="check" size={18} color="#FFD27A" /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginBottom: 18 },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "rgba(255,210,122,0.35)",
    backgroundColor: "rgba(255,210,122,0.10)",
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#FFD27A" },
  triggerLabel: { color: "#F5E6B8", fontSize: 13, fontWeight: "600" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#0E0C0A",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: "rgba(245,230,184,0.12)",
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 30,
    maxHeight: "62%",
  },
  sheetTitle: {
    color: "#9C8B5C",
    fontSize: 11,
    letterSpacing: 1.6,
    fontWeight: "700",
    textTransform: "uppercase",
    marginBottom: 12,
  },
  list: { flexGrow: 0 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  optionActive: {},
  optionLabel: { color: "#D8CDB0", fontSize: 16, flex: 1 },
  optionLabelActive: { color: "#FFD27A", fontWeight: "600" },
  badge: {
    color: "#9C8B5C",
    fontSize: 9,
    letterSpacing: 1.2,
    fontWeight: "700",
    borderWidth: 1,
    borderColor: "rgba(245,230,184,0.18)",
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
});
