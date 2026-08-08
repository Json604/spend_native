import { StyleSheet, Text, View } from "react-native";

export default function SpendTodayHeroCard({
  todayFormatted,
  deltaLabel,
}: {
  todayFormatted: string;
  deltaLabel?: string;
}) {
  const cleaned = todayFormatted.replace(/^Rs/i, "").replace(/^₹/, "").trim() || "0";

  return (
    <View style={styles.card}>
      <Text style={styles.label}>TODAY'S SPEND</Text>
      <View style={styles.row}>
        <Text style={styles.currency}>₹</Text>
        <Text style={styles.hero}>{cleaned}</Text>
        {deltaLabel ? <Text style={styles.delta}>{deltaLabel}</Text> : null}
      </View>
    </View>
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
  label: {
    color: "#9C8B5C",
    fontSize: 10,
    letterSpacing: 1.6,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  row: { flexDirection: "row", alignItems: "baseline", marginTop: 10 },
  currency: { color: "#7A6B41", fontSize: 20, marginRight: 6 },
  hero: { color: "#F5E6B8", fontSize: 48, fontWeight: "300", letterSpacing: -1.6 },
  delta: {
    color: "#5C7A5C",
    fontSize: 11,
    marginLeft: "auto",
    backgroundColor: "rgba(92,122,92,0.08)",
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(92,122,92,0.18)",
  },
});
