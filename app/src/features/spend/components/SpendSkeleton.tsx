import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

/**
 * A skeleton should be the shape of the thing it stands in for. A one-line
 * "syncing" banner tells the user something is happening but nothing about
 * what, and the page underneath still reads as empty — which is exactly what
 * data loss looks like. These mirror the real cards, so the layout the user is
 * waiting for is already visible in outline.
 */

function useShimmer() {
  const value = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 0.8, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(value, { toValue: 0.35, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value]);
  return value;
}

function Bone({ width, height, radius = 8, style }: { width: number | string; height: number; radius?: number; style?: object }) {
  const opacity = useShimmer();
  return (
    <Animated.View
      style={[
        { width: width as number, height, borderRadius: radius, backgroundColor: "rgba(255,255,255,0.09)", opacity },
        style,
      ]}
    />
  );
}

/** Today's total — one big number on a card. */
function HeroSkeleton() {
  return (
    <View style={styles.card}>
      <Bone width="35%" height={12} />
      <Bone width="55%" height={32} radius={10} style={{ marginTop: 14 }} />
    </View>
  );
}

/** Budget: a label, a total, and a progress track. */
function BudgetSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Bone width="40%" height={13} />
        <Bone width="22%" height={13} />
      </View>
      <Bone width="100%" height={8} radius={4} style={{ marginTop: 18 }} />
      <View style={[styles.rowBetween, { marginTop: 14 }]}>
        <Bone width="30%" height={11} />
        <Bone width="26%" height={11} />
      </View>
    </View>
  );
}

/** The daily bar chart — a row of bars of varying height. */
function BarsSkeleton() {
  const heights = [34, 52, 26, 68, 44, 58, 30, 62, 40, 48, 24, 56];
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Bone width="32%" height={13} />
        <Bone width="20%" height={13} />
      </View>
      <View style={styles.barsRow}>
        {heights.map((height, index) => (
          <Bone key={index} width={10} height={height} radius={5} />
        ))}
      </View>
    </View>
  );
}

/** A list of transactions or categories: icon, two lines, an amount. */
function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <View style={styles.card}>
      <Bone width="42%" height={13} />
      {Array.from({ length: rows }).map((_, index) => (
        <View key={index} style={styles.listRow}>
          <Bone width={34} height={34} radius={17} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Bone width="62%" height={12} />
            <Bone width="38%" height={10} style={{ marginTop: 7 }} />
          </View>
          <Bone width={58} height={14} />
        </View>
      ))}
    </View>
  );
}

/** The whole page in outline, matching the real card order. */
export function SpendScreenSkeleton() {
  return (
    <View>
      <HeroSkeleton />
      <BudgetSkeleton />
      <BarsSkeleton />
      <ListSkeleton rows={4} />
      <ListSkeleton rows={3} />
    </View>
  );
}

/** The budget planner: a long list of category rows with amounts. */
export function BudgetPlannerSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <View style={{ paddingTop: 4 }}>
      {Array.from({ length: rows }).map((_, index) => (
        <View key={index} style={styles.plannerRow}>
          <Bone width={`${46 + ((index * 7) % 22)}%` as unknown as number} height={14} />
          <Bone width={62} height={14} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255,255,255,0.035)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    padding: 18,
    marginBottom: 14,
  },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  barsRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    height: 74,
    marginTop: 20,
  },
  listRow: { flexDirection: "row", alignItems: "center", marginTop: 18 },
  plannerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
});
