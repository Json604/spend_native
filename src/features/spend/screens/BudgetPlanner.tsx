import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSpend } from "../store/SpendProvider";
import { monthKeyFromDate } from "../store/budgetStorage";
import type { CategoryBudgetMap, SpendCategoryId } from "../types/types";

const formatRupees = (minor: number): string => {
  const amount = minor / 100;
  const whole = Number.isInteger(amount);
  return whole ? amount.toFixed(0) : amount.toFixed(2);
};

export default function BudgetPlanner() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { actions, currentMonthBudget, categoryOptions } = useSpend();

  const now = new Date();
  const monthKey = monthKeyFromDate(now);
  const monthName = now.toLocaleString(undefined, { month: "long" });

  // Initial form state seeded from existing budget if any (rupees as text per row)
  const [rows, setRows] = useState<Record<string, string>>(() => {
    const existing = currentMonthBudget?.categoryBudgets ?? {};
    const seeded: Record<string, string> = {};
    for (const opt of categoryOptions) {
      const minor = existing[opt.id];
      seeded[opt.id] = minor && minor > 0 ? formatRupees(minor) : "";
    }
    return seeded;
  });

  const [extraRows, setExtraRows] = useState<{ id: string; label: string; tint: string }[]>(() => {
    // Show any saved budget keys that aren't in current categoryOptions
    const knownIds = new Set(categoryOptions.map((o) => o.id as string));
    const existing = currentMonthBudget?.categoryBudgets ?? {};
    return Object.keys(existing)
      .filter((id) => !knownIds.has(id))
      .map((id) => ({ id, label: id, tint: "#9C8B5C" }));
  });

  const [addModalVisible, setAddModalVisible] = useState(false);
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [newCategoryParentId, setNewCategoryParentId] = useState<SpendCategoryId | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const addInputRef = useRef<TextInput>(null);
  const editNameInputRef = useRef<TextInput>(null);
  const editAmountInputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!addModalVisible) return;
    const t = setTimeout(() => addInputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [addModalVisible]);

  const [editingCategoryId, setEditingCategoryId] = useState<SpendCategoryId | null>(null);
  const [editFocusTarget, setEditFocusTarget] = useState<"name" | "amount">("name");
  const [editingLabel, setEditingLabel] = useState("");
  const [editingAmount, setEditingAmount] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const editingCategory = useMemo(
    () => categoryOptions.find((c) => c.id === editingCategoryId) ?? null,
    [categoryOptions, editingCategoryId],
  );

  const openEditCategory = (
    id: SpendCategoryId,
    label: string,
    focusTarget: "name" | "amount",
  ) => {
    setEditFocusTarget(focusTarget);
    setEditingCategoryId(id);
    setEditingLabel(label);
    setEditingAmount(rows[id] ?? "");
  };

  useEffect(() => {
    if (editingCategoryId === null) return;
    const t = setTimeout(() => {
      const input =
        editFocusTarget === "amount"
          ? editAmountInputRef.current
          : editNameInputRef.current;
      input?.focus();
    }, 250);
    return () => clearTimeout(t);
  }, [editingCategoryId, editFocusTarget]);

  const closeEditCategory = () => {
    if (savingEdit) return;
    setEditingCategoryId(null);
    setEditFocusTarget("name");
    setEditingLabel("");
    setEditingAmount("");
  };

  const confirmEdit = async () => {
    if (!editingCategoryId) return;
    const trimmedLabel = editingLabel.trim();
    const labelChanged = trimmedLabel && trimmedLabel !== editingCategory?.label;
    const amountChanged = (rows[editingCategoryId] ?? "") !== editingAmount;

    if (!labelChanged && !amountChanged) {
      closeEditCategory();
      return;
    }

    setSavingEdit(true);
    try {
      if (labelChanged) {
        await actions.renameCategory(editingCategoryId, trimmedLabel);
      }
      if (amountChanged) {
        // Stage the new amount in the inline rows map. It gets persisted to the
        // budget on Save (top-level), matching how all other rows behave.
        setRows((prev) => ({ ...prev, [editingCategoryId]: editingAmount }));
      }
      closeEditCategory();
    } catch (err) {
      Alert.alert(
        "Couldn't save",
        err instanceof Error ? err.message : "Try again.",
      );
    } finally {
      setSavingEdit(false);
    }
  };

  const confirmDelete = () => {
    if (!editingCategoryId) return;
    const label = editingCategory?.label ?? "this category";
    Alert.alert(
      `Delete "${label}"?`,
      "Any transactions tagged with this category will become uncategorized. Its budget will also be removed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setSavingEdit(true);
            try {
              await actions.deleteCategory(editingCategoryId);
              setExtraRows((prev) => prev.filter((r) => r.id !== editingCategoryId));
              setRows((prev) => {
                const next = { ...prev };
                delete next[editingCategoryId];
                return next;
              });
              closeEditCategory();
            } finally {
              setSavingEdit(false);
            }
          },
        },
      ],
    );
  };

  type PlannerRow = {
    id: string;
    label: string;
    tint: string;
    depth: number;
    parentId?: string;
  };

  const allRows = useMemo<PlannerRow[]>(() => {
    const merged: PlannerRow[] = [];
    const childrenByParent = new Map<string, typeof categoryOptions>();
    const roots: typeof categoryOptions = [];
    for (const opt of categoryOptions) {
      if (opt.parentId) {
        const list = childrenByParent.get(opt.parentId) ?? [];
        list.push(opt);
        childrenByParent.set(opt.parentId, list);
      } else {
        roots.push(opt);
      }
    }
    const sortedRoots = [...roots].sort((a, b) => a.label.localeCompare(b.label));
    for (const root of sortedRoots) {
      merged.push({
        id: root.id,
        label: root.label,
        tint: root.tint,
        depth: 0,
        parentId: undefined,
      });
      const children = (childrenByParent.get(root.id) ?? []).sort((a, b) =>
        a.label.localeCompare(b.label),
      );
      for (const child of children) {
        merged.push({
          id: child.id,
          label: child.label,
          tint: child.tint,
          depth: 1,
          parentId: root.id,
        });
      }
    }
    // Orphan children whose parent isn't in categoryOptions (rare) get rendered flat
    const known = new Set(merged.map((r) => r.id));
    for (const opt of categoryOptions) {
      if (!known.has(opt.id)) {
        merged.push({ id: opt.id, label: opt.label, tint: opt.tint, depth: 0 });
        known.add(opt.id);
      }
    }
    // Saved-budget rows that don't match any current category at all
    for (const row of extraRows) {
      if (!known.has(row.id)) {
        merged.push({ id: row.id, label: row.label, tint: row.tint, depth: 0 });
        known.add(row.id);
      }
    }
    return merged;
  }, [categoryOptions, extraRows]);

  const rootOptions = useMemo(
    () =>
      categoryOptions
        .filter((opt) => !opt.parentId)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [categoryOptions],
  );

  const openAddCategory = () => {
    setNewCategoryLabel("");
    setNewCategoryParentId(null);
    setAddModalVisible(true);
  };

  const closeAddCategory = () => {
    if (creatingCategory) return;
    setAddModalVisible(false);
    setNewCategoryLabel("");
    setNewCategoryParentId(null);
  };

  const confirmAddCategory = async () => {
    const trimmed = newCategoryLabel.trim();
    if (!trimmed) return;
    setCreatingCategory(true);
    try {
      const created = await actions.addCategory(
        trimmed,
        newCategoryParentId ? { parentId: newCategoryParentId } : undefined,
      );
      setExtraRows((prev) =>
        prev.some((r) => r.id === created.id)
          ? prev
          : [...prev, { id: created.id, label: created.label, tint: created.tint }],
      );
      setRows((prev) => ({ ...prev, [created.id]: prev[created.id] ?? "" }));
      setAddModalVisible(false);
      setNewCategoryLabel("");
      setNewCategoryParentId(null);
    } catch (err) {
      Alert.alert(
        "Couldn't add category",
        err instanceof Error ? err.message : "Try a different name.",
      );
    } finally {
      setCreatingCategory(false);
    }
  };

  const totalMinor = useMemo(() => {
    let sum = 0;
    for (const id of Object.keys(rows)) {
      const parsed = parseFloat((rows[id] ?? "").replace(/,/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) {
        sum += Math.round(parsed * 100);
      }
    }
    return sum;
  }, [rows]);

  const onSave = async () => {
    const map: CategoryBudgetMap = {};
    for (const id of Object.keys(rows)) {
      const parsed = parseFloat((rows[id] ?? "").replace(/,/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) {
        map[id] = Math.round(parsed * 100);
      }
    }
    if (Object.keys(map).length === 0) {
      // User zero'd everything → wipe the month entry entirely
      await actions.clearMonthlyBudget(monthKey);
    } else {
      await actions.setMonthlyBudget(monthKey, map);
    }
    navigation.goBack();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.container, { paddingTop: insets.top + 16 }]}
    >
      <Pressable onPress={() => navigation.goBack()} style={styles.back}>
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>

      <Text style={styles.title}>{monthName} budget</Text>
      <Text style={styles.helper}>
        Set per-category limits. Your monthly total adds up automatically.
      </Text>

      <View style={styles.totalCard}>
        <Text style={styles.totalLabel}>MONTHLY TOTAL</Text>
        <Text style={styles.totalAmount}>
          ₹{(totalMinor / 100).toLocaleString()}
        </Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {allRows.length === 0 ? (
          <Text style={styles.emptyText}>
            No categories yet. Add one to start budgeting.
          </Text>
        ) : null}

        {allRows.map((row) => (
          <View
            key={row.id}
            style={[styles.row, row.depth > 0 && styles.rowChild]}
          >
            <Pressable
              style={styles.rowLeft}
              onPress={() =>
                openEditCategory(row.id as SpendCategoryId, row.label, "name")
              }
              onLongPress={() =>
                openEditCategory(row.id as SpendCategoryId, row.label, "name")
              }
              delayLongPress={350}
            >
              <View style={[styles.dot, { backgroundColor: row.tint }]} />
              <Text
                style={[styles.rowLabel, row.depth > 0 && styles.rowLabelChild]}
                numberOfLines={1}
              >
                {row.label}
              </Text>
            </Pressable>
            <Pressable
              hitSlop={10}
              onPress={() =>
                openEditCategory(row.id as SpendCategoryId, row.label, "name")
              }
              style={styles.editBtn}
            >
              <Text style={styles.editBtnText}>⋯</Text>
            </Pressable>
            <Pressable
              style={styles.rowRight}
              onPress={() =>
                openEditCategory(row.id as SpendCategoryId, row.label, "amount")
              }
            >
              <Text style={styles.currency}>₹</Text>
              <Text style={[styles.amountDisplay, !rows[row.id] && styles.amountDisplayEmpty]}>
                {rows[row.id] || "0"}
              </Text>
            </Pressable>
          </View>
        ))}

        <Pressable onPress={openAddCategory} style={styles.addRow}>
          <Text style={styles.addPlus}>+</Text>
          <Text style={styles.addText}>Add category</Text>
        </Pressable>
      </ScrollView>

      <Modal
        animationType="fade"
        transparent
        visible={addModalVisible}
        onRequestClose={closeAddCategory}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeAddCategory} />
          <View style={styles.modalSheet}>
            <Text style={styles.modalKicker}>New category</Text>
            <Text style={styles.modalTitle}>Name this category</Text>
            <Text style={styles.modalHint}>
              It'll show up in this month's planner and on the budget breakdown.
            </Text>
            <TextInput
              ref={addInputRef}
              value={newCategoryLabel}
              onChangeText={setNewCategoryLabel}
              placeholder="Rent, Family, Subscriptions..."
              placeholderTextColor="rgba(180,220,240,0.35)"
              style={styles.modalInput}
              editable={!creatingCategory}
              onSubmitEditing={confirmAddCategory}
            />

            {rootOptions.length > 0 ? (
              <>
                <Text style={styles.parentLabel}>Add under (optional)</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.parentChipWrap}
                  keyboardShouldPersistTaps="handled"
                >
                  <Pressable
                    onPress={() => setNewCategoryParentId(null)}
                    style={[
                      styles.parentChip,
                      newCategoryParentId === null && styles.parentChipActive,
                    ]}
                  >
                    <Text style={styles.parentChipText}>None (top-level)</Text>
                  </Pressable>
                  {rootOptions.map((opt) => {
                    const active = newCategoryParentId === opt.id;
                    return (
                      <Pressable
                        key={opt.id}
                        onPress={() => setNewCategoryParentId(opt.id)}
                        style={[
                          styles.parentChip,
                          { borderColor: opt.tint },
                          active && styles.parentChipActive,
                        ]}
                      >
                        <View
                          style={[styles.parentChipDot, { backgroundColor: opt.tint }]}
                        />
                        <Text style={styles.parentChipText}>{opt.label}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </>
            ) : null}

            <View style={styles.modalActions}>
              <Pressable style={styles.modalBtn} onPress={closeAddCategory} disabled={creatingCategory}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.modalBtn,
                  styles.modalBtnPrimary,
                  newCategoryLabel.trim().length === 0 && styles.modalBtnDisabled,
                ]}
                onPress={confirmAddCategory}
                disabled={creatingCategory || newCategoryLabel.trim().length === 0}
              >
                <Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>
                  {creatingCategory ? "Adding..." : "Add"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        transparent
        visible={editingCategoryId !== null}
        onRequestClose={closeEditCategory}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeEditCategory} />
          <View style={styles.modalSheet}>
            <Text style={styles.modalKicker}>Edit category</Text>
            <Text style={styles.modalTitle}>{editingCategory?.label ?? ""}</Text>

            <Text style={styles.parentLabel}>Name</Text>
            <TextInput
              ref={editNameInputRef}
              value={editingLabel}
              onChangeText={setEditingLabel}
              placeholder="Category name"
              placeholderTextColor="rgba(180,220,240,0.35)"
              style={styles.modalInput}
              editable={!savingEdit}
              selectTextOnFocus={editFocusTarget === "name"}
            />

            <Text style={styles.parentLabel}>Budget amount</Text>
            <View style={styles.amountInputWrap}>
              <Text style={styles.amountInputCurrency}>₹</Text>
              <TextInput
                ref={editAmountInputRef}
                value={editingAmount}
                onChangeText={setEditingAmount}
                placeholder="0"
                placeholderTextColor="rgba(180,220,240,0.35)"
                keyboardType="numeric"
                style={styles.amountInputField}
                editable={!savingEdit}
                selectTextOnFocus={editFocusTarget === "amount"}
                onSubmitEditing={confirmEdit}
              />
            </View>

            <View style={styles.modalActions}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnDanger]}
                onPress={confirmDelete}
                disabled={savingEdit}
              >
                <Text style={[styles.modalBtnText, styles.modalBtnTextDanger]}>Delete</Text>
              </Pressable>
              <Pressable style={styles.modalBtn} onPress={closeEditCategory} disabled={savingEdit}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={confirmEdit}
                disabled={savingEdit || editingLabel.trim().length === 0}
              >
                <Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>
                  {savingEdit ? "Saving..." : "Save"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Pressable
        onPress={onSave}
        style={[styles.button, totalMinor <= 0 && styles.buttonDisabled]}
        disabled={totalMinor <= 0}
      >
        <Text style={styles.buttonText}>Save</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#070709", padding: 24 },
  back: { paddingVertical: 8 },
  backText: { color: "#9C8B5C", fontSize: 14 },
  title: { color: "#F5E6B8", fontSize: 22, fontWeight: "500", marginTop: 8 },
  helper: { color: "#9C8B5C", fontSize: 13, marginTop: 6, marginBottom: 18 },
  totalCard: {
    backgroundColor: "rgba(255,210,122,0.06)",
    borderColor: "rgba(255,210,122,0.18)",
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
  },
  totalLabel: { color: "#9C8B5C", fontSize: 10, letterSpacing: 1.6, fontWeight: "600" },
  totalAmount: { color: "#F5E6B8", fontSize: 28, fontWeight: "300", marginTop: 4 },
  scroll: { flex: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  rowLeft: { flexDirection: "row", alignItems: "center", flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  rowLabel: { color: "#D8CDB0", fontSize: 15, fontWeight: "500" },
  rowRight: { flexDirection: "row", alignItems: "center" },
  currency: { color: "#7A6B41", fontSize: 16, marginRight: 4 },
  input: {
    color: "#F5E6B8",
    fontSize: 18,
    minWidth: 90,
    textAlign: "right",
    paddingVertical: 6,
  },
  button: {
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: "#FFD27A",
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "rgb(7,7,9)", fontSize: 15, fontWeight: "600" },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    marginTop: 6,
  },
  addPlus: {
    color: "#FFD27A",
    fontSize: 18,
    width: 22,
    textAlign: "center",
    marginRight: 6,
  },
  addText: { color: "#FFD27A", fontSize: 14, fontWeight: "500" },
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
    paddingBottom: 32,
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
  modalHint: { color: "#8F8F96", fontSize: 12, marginTop: 8, lineHeight: 18 },
  modalInput: {
    color: "#F5E6B8",
    fontSize: 14,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "rgba(245,230,184,0.10)",
    marginTop: 14,
  },
  modalActions: { flexDirection: "row", gap: 8, marginTop: 16, justifyContent: "flex-end" },
  modalBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  modalBtnText: { color: "#D8CDB0", fontSize: 13, fontWeight: "500" },
  modalBtnPrimary: { backgroundColor: "#FFD27A", borderColor: "#FFD27A" },
  modalBtnTextPrimary: { color: "rgb(7,7,9)" },
  modalBtnDisabled: { opacity: 0.45 },
  emptyText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    paddingVertical: 12,
  },
  rowChild: { paddingLeft: 22 },
  rowLabelChild: { fontSize: 13, color: "rgba(216,205,176,0.85)" },
  parentLabel: {
    color: "#9C8B5C",
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginTop: 18,
    marginBottom: 8,
  },
  parentChipWrap: {
    flexDirection: "row",
    gap: 8,
    paddingRight: 8,
  },
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
  editBtn: { paddingHorizontal: 8, paddingVertical: 4, marginRight: 4 },
  editBtnText: { color: "#9C8B5C", fontSize: 22, fontWeight: "600", lineHeight: 22 },
  modalBtnDanger: { borderColor: "rgba(255,142,114,0.55)" },
  modalBtnTextDanger: { color: "#FF8E72" },
  amountInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "rgba(245,230,184,0.10)",
    marginTop: 4,
  },
  amountInputCurrency: { color: "#7A6B41", fontSize: 16, marginRight: 6 },
  amountInputField: { flex: 1, color: "#F5E6B8", fontSize: 16, paddingVertical: 10 },
  amountDisplay: {
    color: "#F5E6B8",
    fontSize: 18,
    minWidth: 60,
    textAlign: "right",
    paddingVertical: 6,
  },
  amountDisplayEmpty: { color: "#5C5240" },
});
