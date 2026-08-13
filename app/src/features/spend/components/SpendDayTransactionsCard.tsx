import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  SpendCategoryId,
  SpendCategoryOption,
  SpendPlanType,
  SpendTransaction,
} from "../types/types";

type Props = {
  dayLabel: string;
  isToday: boolean;
  transactions: SpendTransaction[];
  categoryOptions: SpendCategoryOption[];
  onAssignCategory: (
    transactionId: string,
    categoryLabel: string,
    opts?: { parentId?: SpendCategoryId },
  ) => Promise<void> | void;
  onDeleteTransaction: (transactionId: string) => Promise<void> | void;
  onSetPlanType?: (transactionId: string, planType: SpendPlanType) => Promise<void> | void;
};

function formatCurrency(amountMinor: number) {
  const amount = amountMinor / 100;
  const whole = Number.isInteger(amount);
  return `₹${whole ? amount.toFixed(0) : amount.toFixed(2)}`;
}

export default function SpendDayTransactionsCard({
  dayLabel,
  isToday,
  transactions,
  categoryOptions,
  onAssignCategory,
  onDeleteTransaction,
  onSetPlanType,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [customParentId, setCustomParentId] = useState<SpendCategoryId | null>(null);
  const [busy, setBusy] = useState(false);

  const rootOptions = useMemo(
    () =>
      categoryOptions
        .filter((opt) => !opt.parentId)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [categoryOptions],
  );

  const editingTx = useMemo(
    () => transactions.find((t) => t.id === editingId) ?? null,
    [transactions, editingId],
  );

  const totals = useMemo(() => {
    const totalMinor = transactions.reduce((sum, t) => sum + t.amountMinor, 0);
    const byCategory = new Map<string, { label: string; tint: string; amount: number }>();
    const tintByLabel = new Map(categoryOptions.map((o) => [o.label, o.tint]));
    transactions.forEach((t) => {
      const label = t.categoryLabel ?? "Needs review";
      const prev = byCategory.get(label);
      const tint = tintByLabel.get(label) ?? "#9C8B5C";
      byCategory.set(label, {
        label,
        tint,
        amount: (prev?.amount ?? 0) + t.amountMinor,
      });
    });
    const breakdown = Array.from(byCategory.values()).sort(
      (a, b) => b.amount - a.amount,
    );
    return { totalMinor, breakdown };
  }, [transactions, categoryOptions]);

  const closeEdit = () => {
    if (busy) return;
    setEditingId(null);
    setCustomLabel("");
    setCustomParentId(null);
  };

  const assign = async (
    label: string,
    opts?: { parentId?: SpendCategoryId; isNewCustom?: boolean },
  ) => {
    if (!editingTx) return;
    const trimmed = label.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      // Only forward parentId when creating a brand-new category from the custom
      // input — picking an existing chip should never re-parent it.
      const forwardOpts =
        opts?.isNewCustom && opts.parentId
          ? { parentId: opts.parentId }
          : undefined;
      await onAssignCategory(editingTx.id, trimmed, forwardOpts);
      setEditingId(null);
      setCustomLabel("");
      setCustomParentId(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editingTx) return;
    setBusy(true);
    try {
      await onDeleteTransaction(editingTx.id);
      setEditingId(null);
      setCustomLabel("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>
          {(isToday ? "TODAY" : dayLabel.toUpperCase())}
        </Text>
        <Text style={styles.totalText}>{formatCurrency(totals.totalMinor)}</Text>
      </View>

      {totals.breakdown.length > 0 ? (
        <View style={styles.breakdown}>
          {totals.breakdown.map((b) => (
            <View key={b.label} style={styles.breakdownRow}>
              <View style={[styles.dot, { backgroundColor: b.tint }]} />
              <Text style={styles.breakdownLabel}>{b.label}</Text>
              <Text style={styles.breakdownAmount}>
                {formatCurrency(b.amount)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {transactions.length === 0 ? (
        <Text style={styles.empty}>
          {isToday ? "No transactions today yet." : "No transactions this day."}
        </Text>
      ) : (
        <View style={styles.list}>
          {transactions.map((t) => (
            <Pressable
              key={t.allocationId ? `${t.id}:${t.allocationId}` : t.id}
              onPress={() => {
                setEditingId(t.id);
                setCustomLabel("");
              }}
              style={styles.row}
            >
              <View style={{ flex: 1 }}>
                <View style={styles.merchantRow}>
                  <Text style={styles.merchant}>{t.merchantName}</Text>
                  {t.planType === "unplanned" ? (
                    <View style={styles.unplannedBadge}>
                      <Text style={styles.unplannedBadgeText}>UNPLANNED</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.meta}>
                  {new Date(t.occurredAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {t.categoryLabel ? ` · ${t.categoryLabel}` : " · Needs review"}
                  {t.channel !== "unknown" ? ` · ${t.channel.toUpperCase()}` : ""}
                </Text>
              </View>
              <Text style={styles.amt}>{formatCurrency(t.amountMinor)}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <Modal
        animationType="fade"
        transparent
        visible={!!editingTx}
        onRequestClose={closeEdit}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeEdit} />
          <View style={styles.modalSheet}>
            <Text style={styles.modalKicker}>Edit transaction</Text>
            <Text style={styles.modalTitle}>{editingTx?.merchantName}</Text>
            <Text style={styles.modalMeta}>
              {editingTx ? formatCurrency(editingTx.amountMinor) : ""}
              {editingTx
                ? `  •  ${new Date(editingTx.occurredAt).toLocaleString()}`
                : ""}
            </Text>

            {onSetPlanType ? (
              <>
                <Text style={styles.sectionLabel}>Type</Text>
                <View style={styles.planRow}>
                  {(["planned", "unplanned"] as const).map((pt) => {
                    const active = (editingTx?.planType ?? "planned") === pt;
                    return (
                      <Pressable
                        key={pt}
                        disabled={busy}
                        onPress={() => editingTx && onSetPlanType(editingTx.id, pt)}
                        style={[
                          styles.planChip,
                          active && (pt === "planned" ? styles.planChipPlannedActive : styles.planChipUnplannedActive),
                        ]}
                      >
                        <Text style={[styles.planChipText, active && styles.planChipTextActive]}>
                          {pt === "planned" ? "Planned" : "Unplanned"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            <Text style={styles.sectionLabel}>Category</Text>
            <ScrollView
              style={{ maxHeight: 180 }}
              contentContainerStyle={styles.optionWrap}
              keyboardShouldPersistTaps="handled"
            >
              {categoryOptions.map((opt) => {
                const isCurrent = editingTx?.categoryLabel === opt.label;
                return (
                  <Pressable
                    key={opt.id}
                    disabled={busy}
                    onPress={() => assign(opt.label)}
                    style={[
                      styles.chip,
                      { borderColor: opt.tint },
                      isCurrent && styles.chipActive,
                    ]}
                  >
                    <View style={[styles.chipDot, { backgroundColor: opt.tint }]} />
                    <Text style={styles.chipText}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <Text style={styles.sectionLabel}>Or type a new category</Text>
            <TextInput
              value={customLabel}
              onChangeText={setCustomLabel}
              placeholder="Rent, Family, Subscriptions..."
              placeholderTextColor="rgba(180,220,240,0.35)"
              style={styles.input}
              editable={!busy}
              onSubmitEditing={() =>
                assign(customLabel, {
                  parentId: customParentId ?? undefined,
                  isNewCustom: true,
                })
              }
            />

            {rootOptions.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>Add under (optional)</Text>
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

            <View style={styles.actions}>
              <Pressable style={[styles.btn, styles.btnDanger]} onPress={remove} disabled={busy}>
                <Text style={[styles.btnText, styles.btnDangerText]}>
                  {busy ? "Working..." : "Delete"}
                </Text>
              </Pressable>
              <Pressable style={styles.btn} onPress={closeEdit} disabled={busy}>
                <Text style={styles.btnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.btn, styles.btnPrimary]}
                onPress={() =>
                  assign(customLabel, {
                    parentId: customParentId ?? undefined,
                    isNewCustom: true,
                  })
                }
                disabled={busy || customLabel.trim().length === 0}
              >
                <Text style={[styles.btnText, styles.btnPrimaryText]}>
                  {busy ? "Saving..." : "Save"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  label: {
    color: "#9C8B5C",
    fontSize: 10,
    letterSpacing: 1.6,
    fontWeight: "600",
  },
  totalText: {
    color: "#F5E6B8",
    fontSize: 15,
    fontWeight: "600",
  },
  breakdown: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(245,230,184,0.08)",
    gap: 6,
  },
  breakdownRow: { flexDirection: "row", alignItems: "center" },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  breakdownLabel: { color: "#D8CDB0", fontSize: 12, flex: 1 },
  breakdownAmount: { color: "rgba(255,255,255,0.65)", fontSize: 12 },
  empty: { color: "#8F8F96", fontSize: 12, marginTop: 12 },
  list: { marginTop: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(245,230,184,0.08)",
  },
  merchantRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  merchant: { color: "#D8CDB0", fontWeight: "500", fontSize: 13 },
  unplannedBadge: {
    backgroundColor: "rgba(180,160,255,0.14)",
    borderColor: "rgba(180,160,255,0.35)",
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  unplannedBadgeText: {
    color: "rgba(220,210,255,0.95)",
    fontSize: 8,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  planRow: { flexDirection: "row", gap: 8 },
  planChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.03)",
    alignItems: "center",
  },
  planChipPlannedActive: {
    borderColor: "rgba(255,210,122,0.55)",
    backgroundColor: "rgba(255,210,122,0.10)",
  },
  planChipUnplannedActive: {
    borderColor: "rgba(180,160,255,0.55)",
    backgroundColor: "rgba(180,160,255,0.10)",
  },
  planChipText: { color: "#D8CDB0", fontSize: 13, fontWeight: "600" },
  planChipTextActive: { color: "#F5E6B8" },
  meta: { color: "#8F8F96", fontSize: 10, marginTop: 2 },
  amt: { color: "#F5E6B8", fontWeight: "500", fontSize: 13 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#0E0C0A",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 22,
    borderTopWidth: 1,
    borderColor: "rgba(245,230,184,0.10)",
  },
  modalKicker: {
    color: "#9C8B5C",
    fontSize: 11,
    letterSpacing: 1.6,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  modalTitle: { color: "#F5E6B8", fontSize: 20, fontWeight: "500", marginTop: 6 },
  modalMeta: { color: "#9C8B5C", fontSize: 12, marginTop: 4 },
  sectionLabel: {
    color: "#9C8B5C",
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginTop: 18,
    marginBottom: 8,
  },
  optionWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
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
  input: {
    color: "#F5E6B8",
    fontSize: 14,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "rgba(245,230,184,0.10)",
  },
  actions: { flexDirection: "row", gap: 8, marginTop: 18, justifyContent: "flex-end" },
  btn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  btnText: { color: "#D8CDB0", fontSize: 13, fontWeight: "500" },
  btnPrimary: { backgroundColor: "#FFD27A", borderColor: "#FFD27A" },
  btnPrimaryText: { color: "rgb(7,7,9)" },
  btnDanger: { borderColor: "rgba(255,142,114,0.6)" },
  btnDangerText: { color: "#FF8E72" },
  parentChipWrap: { flexDirection: "row", gap: 8, paddingRight: 8 },
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
});
