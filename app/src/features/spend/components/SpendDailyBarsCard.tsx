import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import SpendSurface from "./SpendSurface";
import type { SpendDailyBucket } from "../types/types";

type SpendDailyBarsCardProps = {
  buckets: SpendDailyBucket[];
  selectedDate?: string | null;
  onSelectDate?: (date: string | null) => void;
};

const CHART_HEIGHT = 132;
const MIN_VISIBLE_HEIGHT = 3;
const BAR_SLOT_WIDTH = 24;
const BAR_GAP = 8;

function formatCompactCurrency(amountMinor: number) {
  const amount = amountMinor / 100;

  if (amount >= 100000) {
    return `Rs ${(amount / 100000).toFixed(1)}L`;
  }
  if (amount >= 1000) {
    return `Rs ${(amount / 1000).toFixed(amount >= 10000 ? 0 : 1)}k`;
  }

  return `Rs ${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(0)}`;
}

function formatFullCurrency(amountMinor: number) {
  const amount = amountMinor / 100;
  return `Rs ${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)}`;
}

export default function SpendDailyBarsCard({
  buckets,
  selectedDate: selectedDateProp,
  onSelectDate,
}: SpendDailyBarsCardProps) {
  const scrollRef = useRef<ScrollView>(null);
  const highlightAnim = useRef(new Animated.Value(0)).current;
  const [internalSelectedDate, setInternalSelectedDate] = useState<string | null>(null);
  const isControlled = selectedDateProp !== undefined;
  const selectedDate = isControlled ? selectedDateProp ?? null : internalSelectedDate;
  const setSelectedDate = (next: string | null) => {
    if (isControlled) {
      onSelectDate?.(next);
    } else {
      setInternalSelectedDate(next);
      onSelectDate?.(next);
    }
  };

  const { maxAmount, total, activeDays, dailyAverage, peak } = useMemo(() => {
    const values = buckets.map((bucket) => bucket.amountMinor);
    const max = values.reduce((memo, value) => Math.max(memo, value), 0);
    const totalMinor = values.reduce((memo, value) => memo + value, 0);
    const active = values.filter((value) => value > 0).length;
    const peakBucket = buckets.reduce<SpendDailyBucket | null>(
      (memo, bucket) =>
        !memo || bucket.amountMinor > memo.amountMinor ? bucket : memo,
      null,
    );

    return {
      maxAmount: max,
      total: totalMinor,
      activeDays: active,
      dailyAverage: active > 0 ? totalMinor / active : 0,
      peak: peakBucket,
    };
  }, [buckets]);

  const selectedBucket = useMemo(() => {
    if (!selectedDate) {
      return null;
    }
    return buckets.find((bucket) => bucket.date === selectedDate) ?? null;
  }, [buckets, selectedDate]);

  const todayBucket = useMemo(
    () => buckets.find((bucket) => bucket.isToday) ?? null,
    [buckets],
  );

  useEffect(() => {
    if (!selectedBucket) {
      highlightAnim.setValue(0);
      return;
    }

    highlightAnim.setValue(0);
    Animated.timing(highlightAnim, {
      toValue: 1,
      duration: 220,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      useNativeDriver: true,
    }).start();
  }, [highlightAnim, selectedBucket?.date]);

  useEffect(() => {
    if (!buckets.length) {
      return;
    }

    const timeout = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 0);

    return () => clearTimeout(timeout);
  }, [buckets.length]);

  const detailBucket = selectedBucket ?? todayBucket;
  const detailEyebrow = selectedBucket
    ? selectedBucket.isToday
      ? "Today"
      : "Selected"
    : "Today";
  const detailLabel = detailBucket?.fullLabel ?? `Last ${buckets.length || 30} days`;
  const detailAmount = detailBucket
    ? formatFullCurrency(detailBucket.amountMinor)
    : formatCompactCurrency(total);
  const detailCaption = detailBucket
    ? detailBucket.transactionCount === 0
      ? "No spend recorded"
      : `${detailBucket.transactionCount} transaction${
          detailBucket.transactionCount === 1 ? "" : "s"
        }`
    : "window total";

  const detailHighlightStyle = {
    opacity: highlightAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [selectedBucket ? 0.2 : 1, 1],
    }),
    transform: [
      {
        translateY: highlightAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [selectedBucket ? 6 : 0, 0],
        }),
      },
    ],
  } as const;

  return (
    <SpendSurface>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.eyebrow}>{detailEyebrow}</Text>
          <Animated.Text style={[styles.title, detailHighlightStyle]}>
            {detailLabel}
          </Animated.Text>
        </View>
        <Animated.View style={[styles.totalBlock, detailHighlightStyle]}>
          <Text style={styles.totalValue}>{detailAmount}</Text>
          <Text style={styles.totalCaption}>{detailCaption}</Text>
        </Animated.View>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chartScroll}
        contentContainerStyle={styles.chartContent}
      >
        {buckets.map((bucket) => {
          const isSelected = selectedBucket?.date === bucket.date;
          const isPeak = peak?.date === bucket.date && bucket.amountMinor > 0;
          const ratio =
            maxAmount > 0 && bucket.amountMinor > 0
              ? bucket.amountMinor / maxAmount
              : 0;
          const height = Math.max(
            ratio * CHART_HEIGHT,
            bucket.amountMinor > 0 ? MIN_VISIBLE_HEIGHT : 2,
          );
          const barColor = isSelected
            ? "rgba(255, 215, 0, 0.98)"
            : bucket.isToday
              ? "rgba(255, 215, 0, 0.82)"
              : isPeak
                ? "rgba(255, 215, 0, 0.52)"
                : bucket.amountMinor > 0
                  ? "rgba(255, 255, 255, 0.24)"
                  : "rgba(255, 255, 255, 0.08)";

          return (
            <Pressable
              key={bucket.date}
              onPress={() =>
                setSelectedDate(selectedDate === bucket.date ? null : bucket.date)
              }
              style={styles.barColumn}
              hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            >
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.bar,
                    {
                      height,
                      backgroundColor: barColor,
                      borderColor: isSelected
                        ? "rgba(255, 255, 255, 0.18)"
                        : "transparent",
                      borderWidth: isSelected ? 1 : 0,
                    },
                  ]}
                />
              </View>
              <Text
                style={[
                  styles.dayLabel,
                  bucket.isToday && styles.dayLabelToday,
                  isSelected && styles.dayLabelSelected,
                ]}
              >
                {bucket.dayLabel}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerItem}>
          <Text style={styles.footerLabel}>Window total</Text>
          <Text style={styles.footerValue}>{formatCompactCurrency(total)}</Text>
        </View>
        <View style={styles.footerItem}>
          <Text style={styles.footerLabel}>Daily avg</Text>
          <Text style={styles.footerValue}>{formatCompactCurrency(dailyAverage)}</Text>
        </View>
        <View style={styles.footerItem}>
          <Text style={styles.footerLabel}>Active days</Text>
          <Text style={styles.footerValue}>
            {activeDays}/{buckets.length}
          </Text>
        </View>
        <View style={styles.footerItem}>
          <Text style={styles.footerLabel}>Peak</Text>
          <Text style={styles.footerValue}>
            {peak && peak.amountMinor > 0
              ? formatCompactCurrency(peak.amountMinor)
              : "Rs0"}
          </Text>
        </View>
      </View>
    </SpendSurface>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  headerLeft: {
    flex: 1,
    paddingRight: 12,
  },
  eyebrow: {
    color: "rgba(255, 215, 0, 0.82)",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  title: {
    color: "white",
    fontSize: 18,
    fontWeight: "600",
    marginTop: 6,
  },
  totalBlock: {
    alignItems: "flex-end",
  },
  totalValue: {
    color: "white",
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  totalCaption: {
    color: "rgba(255, 255, 255, 0.5)",
    fontSize: 11,
    marginTop: 2,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  chartScroll: {
    marginTop: 22,
  },
  chartContent: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: BAR_GAP,
    paddingVertical: 4,
    paddingRight: 4,
  },
  barColumn: {
    width: BAR_SLOT_WIDTH,
    alignItems: "center",
    justifyContent: "flex-end",
  },
  barTrack: {
    width: "100%",
    height: CHART_HEIGHT,
    justifyContent: "flex-end",
    alignItems: "center",
  },
  bar: {
    width: "100%",
    borderRadius: 5,
  },
  dayLabel: {
    color: "rgba(255, 255, 255, 0.45)",
    fontSize: 10,
    marginTop: 6,
    fontWeight: "500",
  },
  dayLabelToday: {
    color: "rgba(255, 215, 0, 0.95)",
    fontWeight: "700",
  },
  dayLabelSelected: {
    color: "white",
    fontWeight: "700",
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 20,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.08)",
    paddingTop: 16,
    gap: 10,
  },
  footerItem: {
    flex: 1,
  },
  footerLabel: {
    color: "rgba(255, 255, 255, 0.48)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  footerValue: {
    color: "white",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 4,
  },
});
