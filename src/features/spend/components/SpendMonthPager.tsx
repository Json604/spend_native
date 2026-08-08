import { ScrollView, Pressable, StyleSheet, Text, View } from "react-native";
import { spendMonthLabel } from "../store/sqliteRepository";

type SpendMonthPagerProps = {
  monthKey: string;
  months: string[];
  onSelect: (monthKey: string) => void;
};

export default function SpendMonthPager({ monthKey, months, onSelect }: SpendMonthPagerProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      accessibilityLabel="Choose month"
    >
      {months.map((month) => {
        const active = month === monthKey;
        return (
          <Pressable
            key={month}
            onPress={() => onSelect(month)}
            style={[styles.item, active && styles.itemActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <View style={[styles.dot, active && styles.dotActive]} />
            <Text style={[styles.label, active && styles.labelActive]}>
              {spendMonthLabel(month)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: 8, paddingVertical: 4, paddingRight: 12 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
    borderColor: "rgba(245,230,184,0.10)",
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  itemActive: { backgroundColor: "rgba(255,210,122,0.15)", borderColor: "rgba(255,210,122,0.45)" },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#665B43" },
  dotActive: { backgroundColor: "#FFD27A" },
  label: { color: "#9C8B5C", fontSize: 12 },
  labelActive: { color: "#F5E6B8", fontWeight: "600" },
});
