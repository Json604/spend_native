import { useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSpend } from "../store/SpendProvider";
import type { StackParamList } from "../../../navigation/types";
import type { SpendCategoryId, SpendPlanType } from "../types/types";

type ManualEntryRoute = RouteProp<StackParamList, "SpendManualEntry">;

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Build the occurredAt timestamp for the entry. If the user selected a past
// day on the bar graph, anchor at noon of that day so it lands cleanly inside
// the day bucket; for today, use "now" so the time field reflects when the
// entry was made.
function buildOccurredAt(forDate: Date | null): string {
  const now = new Date();
  if (!forDate || isSameDay(forDate, now)) {
    return now.toISOString();
  }
  const stamped = new Date(forDate);
  stamped.setHours(12, 0, 0, 0);
  return stamped.toISOString();
}

export default function ManualEntrySheet() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<ManualEntryRoute>();
  const { actions, categoryOptions, currentMonthBudget } = useSpend();

  const forDate = useMemo(() => {
    const param = route.params?.forDate;
    if (!param) return null;
    const parsed = new Date(param);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [route.params?.forDate]);

  const dayLabel = useMemo(() => {
    if (!forDate) return "Today";
    const today = new Date();
    if (isSameDay(forDate, today)) return "Today";
    return forDate.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }, [forDate]);

  const [amountText, setAmountText] = useState("");
  const [merchant, setMerchant] = useState("");
  const [note, setNote] = useState("");
  const [selectedCategoryLabel, setSelectedCategoryLabel] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [customParentId, setCustomParentId] = useState<SpendCategoryId | null>(null);
  const [planType, setPlanType] = useState<SpendPlanType>("planned");

  // autoFocus is unreliable inside modal-presented screens — focus fires before
  // the navigator finishes animating. Trigger focus once the screen has settled.
  const amountRef = useRef<TextInput>(null);
  useEffect(() => {
    const t = setTimeout(() => amountRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, []);

  const rootOptions = useMemo(
    () =>
      categoryOptions
        .filter((opt) => !opt.parentId)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [categoryOptions],
  );

  /**
   * The chips offer THIS MONTH's categories, not every category that has ever
   * existed. Budgets are per-month now, so the full list drags along last
   * month's one-offs and every typo ever made — dozens of chips to hunt
   * through for the handful actually in play. Anything missing can still be
   * typed below, and an existing name resolves to that category rather than
   * creating a duplicate.
   *
   * With nothing budgeted there is nothing to narrow to, so fall back to the
   * full list rather than showing an empty picker.
   */
  const monthOptions = useMemo(() => {
    const budgeted = currentMonthBudget?.categoryBudgets ?? {};
    const inThisMonth = categoryOptions.filter((opt) => (budgeted[opt.id] ?? 0) > 0);
    return inThisMonth.length > 0 ? inThisMonth : categoryOptions;
  }, [categoryOptions, currentMonthBudget]);

  const trimmedCustom = customLabel.trim();
  // The custom input is the source of truth when filled; otherwise, fall back
  // to whichever existing category chip the user picked.
  const effectiveCategoryLabel = trimmedCustom || selectedCategoryLabel || undefined;

  const amountMinor =
    Math.round(parseFloat(amountText.replace(/,/g, "")) * 100) || 0;
  const canSave = amountMinor > 0 && merchant.trim().length > 0;

  const onSave = async () => {
    if (!canSave) return;
    await actions.addManualTransaction({
      amountMinor,
      merchantName: merchant.trim(),
      occurredAt: buildOccurredAt(forDate),
      description: note.trim() || undefined,
      categoryLabel: effectiveCategoryLabel,
      // Only forward parent when the user is creating a brand-new category via
      // the custom input — picking an existing chip should never re-parent it.
      categoryParentId:
        trimmedCustom && customParentId ? customParentId : undefined,
      planType,
    });
    navigation.goBack();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.container, { paddingTop: insets.top + 16 }]}
    >
      <Pressable onPress={() => navigation.goBack()} style={styles.back}>
        <Text style={styles.backText}>‹ Cancel</Text>
      </Pressable>

      <Text style={styles.title}>Add transaction</Text>
      <View style={styles.dayPill}>
        <Text style={styles.dayPillText}>For {dayLabel}</Text>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScrollBeginDrag={Keyboard.dismiss}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        <Pressable onPress={Keyboard.dismiss} style={styles.dismissArea} accessible={false} />
        <Text style={styles.label}>Type</Text>
        <View style={styles.planRow}>
          <Pressable
            onPress={() => setPlanType("planned")}
            style={[styles.planChip, planType === "planned" && styles.planChipActive]}
          >
            <Text style={[styles.planChipText, planType === "planned" && styles.planChipTextActive]}>
              Planned
            </Text>
            <Text style={styles.planChipHint}>Counts against budget</Text>
          </Pressable>
          <Pressable
            onPress={() => setPlanType("unplanned")}
            style={[styles.planChip, planType === "unplanned" && styles.planChipUnplannedActive]}
          >
            <Text style={[styles.planChipText, planType === "unplanned" && styles.planChipTextActive]}>
              Unplanned
            </Text>
            <Text style={styles.planChipHint}>From savings · gift, help, one-off</Text>
          </Pressable>
        </View>

        <Text style={styles.label}>Amount</Text>
        <View style={styles.amountRow}>
          <Text style={styles.currency}>₹</Text>
          <TextInput
            ref={amountRef}
            style={styles.amountInput}
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="numeric"
            placeholder="0"
            placeholderTextColor="#5C5240"
          />
        </View>

        <Text style={styles.label}>Merchant</Text>
        <TextInput
          style={styles.input}
          value={merchant}
          onChangeText={setMerchant}
          placeholder="e.g. Swiggy"
          placeholderTextColor="#5C5240"
        />

        <Text style={styles.label}>Category (optional)</Text>
        {monthOptions.length > 0 ? (
          <View style={styles.chipWrap}>
            {monthOptions.map((opt) => {
              const active = selectedCategoryLabel === opt.label && !trimmedCustom;
              return (
                <Pressable
                  key={opt.id}
                  onPress={() => {
                    setCustomLabel("");
                    setCustomParentId(null);
                    setSelectedCategoryLabel(active ? null : opt.label);
                  }}
                  style={[
                    styles.chip,
                    { borderColor: opt.tint },
                    active && styles.chipActive,
                  ]}
                >
                  <View style={[styles.chipDot, { backgroundColor: opt.tint }]} />
                  <Text style={styles.chipText}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <Text style={styles.subLabel}>Or type a new one</Text>
        <TextInput
          style={styles.input}
          value={customLabel}
          onChangeText={(text) => {
            setCustomLabel(text);
            if (text.trim().length > 0) setSelectedCategoryLabel(null);
          }}
          placeholder="Swiggy, Rent, Subscriptions..."
          placeholderTextColor="#5C5240"
        />

        {trimmedCustom.length > 0 && rootOptions.length > 0 ? (
          <>
            <Text style={styles.subLabel}>Add under (optional)</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.parentChipWrap}
              keyboardShouldPersistTaps="handled"
            >
              <Pressable
                onPress={() => setCustomParentId(null)}
                style={[
                  styles.parentChip,
                  customParentId === null && styles.parentChipActive,
                ]}
              >
                <Text style={styles.parentChipText}>None</Text>
              </Pressable>
              {rootOptions.map((opt) => {
                const active = customParentId === opt.id;
                return (
                  <Pressable
                    key={opt.id}
                    onPress={() => setCustomParentId(opt.id)}
                    style={[
                      styles.parentChip,
                      { borderColor: opt.tint },
                      active && styles.parentChipActive,
                    ]}
                  >
                    <View style={[styles.parentChipDot, { backgroundColor: opt.tint }]} />
                    <Text style={styles.parentChipText}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </>
        ) : null}

        <Text style={styles.label}>Note (optional)</Text>
        <TextInput
          style={styles.input}
          value={note}
          onChangeText={setNote}
          placeholder=""
          placeholderTextColor="#5C5240"
        />

        <Pressable
          onPress={onSave}
          style={[styles.button, !canSave && styles.buttonDisabled]}
          disabled={!canSave}
        >
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // Invisible catcher so a tap on empty space closes the keyboard.
  dismissArea: { ...StyleSheet.absoluteFillObject, zIndex: -1 },
  container: { flex: 1, backgroundColor: "#070709", padding: 24 },
  back: { paddingVertical: 8 },
  backText: { color: "#9C8B5C", fontSize: 14 },
  title: { color: "#F5E6B8", fontSize: 20, fontWeight: "500", marginTop: 8 },
  dayPill: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,210,122,0.10)",
    borderColor: "rgba(255,210,122,0.28)",
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    marginTop: 10,
    marginBottom: 6,
  },
  dayPillText: {
    color: "#FFD27A",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  label: {
    color: "#9C8B5C",
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 6,
  },
  amountRow: { flexDirection: "row", alignItems: "baseline" },
  currency: { color: "#7A6B41", fontSize: 22, marginRight: 6 },
  amountInput: { color: "#F5E6B8", fontSize: 42, fontWeight: "300", minWidth: 160 },
  input: {
    color: "#F5E6B8",
    fontSize: 16,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "rgba(245,230,184,0.10)",
  },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  chipActive: { backgroundColor: "rgba(255,210,122,0.15)" },
  chipDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  chipText: { color: "#D8CDB0", fontSize: 12, fontWeight: "500" },
  button: {
    marginTop: 28,
    padding: 16,
    borderRadius: 12,
    backgroundColor: "#FFD27A",
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "rgb(7,7,9)", fontSize: 15, fontWeight: "600" },
  subLabel: {
    color: "#9C8B5C",
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginTop: 14,
    marginBottom: 6,
  },
  parentChipWrap: { flexDirection: "row", gap: 8, paddingRight: 8, marginTop: 2 },
  parentChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  parentChipActive: { backgroundColor: "rgba(255,210,122,0.18)" },
  parentChipDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  parentChipText: { color: "#D8CDB0", fontSize: 12, fontWeight: "500" },
  planRow: { flexDirection: "row", gap: 10 },
  planChip: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  planChipActive: {
    borderColor: "rgba(255,210,122,0.55)",
    backgroundColor: "rgba(255,210,122,0.10)",
  },
  planChipUnplannedActive: {
    borderColor: "rgba(180,160,255,0.55)",
    backgroundColor: "rgba(180,160,255,0.10)",
  },
  planChipText: { color: "#D8CDB0", fontSize: 14, fontWeight: "600" },
  planChipTextActive: { color: "#F5E6B8" },
  planChipHint: { color: "#9C8B5C", fontSize: 10, marginTop: 4 },
});
