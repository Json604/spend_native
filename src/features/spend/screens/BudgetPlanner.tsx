import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
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
import SpendMonthPager from "../components/SpendMonthPager";
import {
  accountingMonthKey,
  previousAccountingMonthKey,
  spendCurrency,
  spendMonthLabel,
} from "../store/sqliteRepository";
import type { SpendCategoryId, SpendCategoryOption } from "../types/types";

const formatRupees = (minor: number): string => {
  const amount = minor / 100;
  return Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2);
};

const parseAmount = (value: string): number | null => {
  const trimmed = value.replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
};

const monthChoicesFor = (monthKey: string): string[] => {
  const result = [monthKey];
  let cursor = monthKey;
  for (let index = 0; index < 2; index += 1) {
    cursor = previousAccountingMonthKey(cursor);
    result.unshift(cursor);
  }
  cursor = monthKey;
  for (let index = 0; index < 2; index += 1) {
    const [year, month] = cursor.split("-").map(Number);
    const next = new Date(Date.UTC(year, month, 1));
    cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    result.push(cursor);
  }
  return result;
};

type SortMode = "amount" | "name" | "percent";
type PlannerOption = SpendCategoryOption & {
  spentMinor: number;
  deltaMinor: number;
  budgetMinor: number;
  recurring: boolean;
};
type PlannerGroup = {
  root: PlannerOption;
  children: PlannerOption[];
};
type ListItem =
  | { type: "section"; id: string; label: string }
  | { type: "group"; id: string; group: PlannerGroup; section: "recurring" | "oneoff" }
  | { type: "child"; id: string; option: PlannerOption };

export default function BudgetPlanner() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const {
    actions,
    currentMonthBudget,
    categoryOptions,
    categories,
    selectedMonth,
    setSelectedMonth,
  } = useSpend();
  const monthKey = selectedMonth;
  const currentMonth = accountingMonthKey();
  const readOnly = monthKey < currentMonth;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sortMode, setSortMode] = useState<SortMode>("amount");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [focusedIds, setFocusedIds] = useState<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [undo, setUndo] = useState<{
    categoryId: SpendCategoryId;
    label: string;
    amountMinor: number;
    recurring: boolean;
    revision: number;
  } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [newCategoryParentId, setNewCategoryParentId] = useState<SpendCategoryId | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [carryForwardBusy, setCarryForwardBusy] = useState(false);
  const addInputRef = useRef<TextInput>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const commitChains = useRef<Record<string, Promise<void>>>({});
  const knownBudget = useRef<Record<string, { amountMinor: number; recurring: boolean }>>({});

  const categoryPreviewById = useMemo(
    () => new Map(categories.filter((category) => category.id).map((category) => [category.id as string, category])),
    [categories],
  );

  const plannerOptions = useMemo<PlannerOption[]>(() => {
    const existing = currentMonthBudget?.categoryBudgets ?? {};
    const recurring = currentMonthBudget?.categoryRecurring ?? {};
    const options = [...categoryOptions];
    const known = new Set<string>(options.map((option) => option.id));
    Object.keys(existing).forEach((id) => {
      if (known.has(id)) return;
      options.push({ id: id as SpendCategoryId, label: id, tint: "#9C8B5C", isCustom: true });
    });
    return options.map((option) => {
      const preview = categoryPreviewById.get(option.id);
      const budgetMinor = existing[option.id] ?? 0;
      knownBudget.current[option.id] = {
        amountMinor: budgetMinor,
        recurring: recurring[option.id] ?? false,
      };
      return {
        ...option,
        spentMinor: preview?.spentMinor ?? 0,
        deltaMinor: preview?.deltaMinor ?? 0,
        budgetMinor,
        recurring: recurring[option.id] ?? false,
      };
    });
  }, [categoryOptions, categories, categoryPreviewById, currentMonthBudget]);

  useEffect(() => {
    setDrafts({});
    setFocusedIds({});
    setExpanded({});
    setSearch("");
  }, [monthKey]);

  useEffect(() => () => {
    Object.values(timers.current).forEach(clearTimeout);
  }, []);

  const groups = useMemo<PlannerGroup[]>(() => {
    // Parent categories are aggregate-only: their budget is the sum of children,
    // so a parent allocation can never overlap the child envelope.
    const childrenByParent = new Map<string, PlannerOption[]>();
    const roots: PlannerOption[] = [];
    plannerOptions.forEach((option) => {
      if (!option.parentId) {
        roots.push(option);
        return;
      }
      const children = childrenByParent.get(option.parentId) ?? [];
      children.push(option);
      childrenByParent.set(option.parentId, children);
    });
    return roots.map((root) => ({ root, children: childrenByParent.get(root.id) ?? [] }));
  }, [plannerOptions]);

  const metric = (option: PlannerOption, key: "amount" | "percent") =>
    key === "percent"
      ? option.budgetMinor > 0 ? option.spentMinor / option.budgetMinor : option.spentMinor > 0 ? 1 : 0
      : option.budgetMinor;

  const groupMetric = (group: PlannerGroup, section: "recurring" | "oneoff", key: "amount" | "percent") => {
    const members = group.children.length > 0 ? group.children : [group.root];
    const sectionMembers = members.filter((member) => section === "recurring" ? member.recurring : !member.recurring);
    return sectionMembers.reduce((sum, member) => sum + metric(member, key), 0);
  };

  const listData = useMemo<ListItem[]>(() => {
    const query = search.trim().toLowerCase();
    const items: ListItem[] = [];
    (["recurring", "oneoff"] as const).forEach((section) => {
      const sectionGroups = groups
        .map((group) => {
          const matchesRoot = !query || group.root.label.toLowerCase().includes(query);
          const children = group.children.filter((child) => {
            const inSection = section === "recurring" ? child.recurring : !child.recurring;
            return inSection && (!query || matchesRoot || child.label.toLowerCase().includes(query));
          });
          const rootIsMember = group.children.length === 0 && (section === "recurring" ? group.root.recurring : !group.root.recurring);
          if (!rootIsMember && children.length === 0) return null;
          return { group, children, rootIsMember };
        })
        .filter((value): value is { group: PlannerGroup; children: PlannerOption[]; rootIsMember: boolean } => value !== null)
        .sort((left, right) => {
          if (sortMode === "name") return left.group.root.label.localeCompare(right.group.root.label);
          return groupMetric(right.group, section, sortMode === "percent" ? "percent" : "amount") - groupMetric(left.group, section, sortMode === "percent" ? "percent" : "amount");
        });
      if (sectionGroups.length === 0) return;
      items.push({ type: "section", id: `section:${section}`, label: section === "recurring" ? "Recurring · carries forward" : "This month only" });
      sectionGroups.forEach(({ group, children, rootIsMember }) => {
        const displayedGroup = rootIsMember ? group : { ...group, children };
        items.push({ type: "group", id: `group:${section}:${group.root.id}`, group: displayedGroup, section });
        if (expanded[group.root.id] || query) {
          displayedGroup.children.forEach((option) => items.push({ type: "child", id: `child:${section}:${option.id}`, option }));
        }
      });
    });
    return items;
  }, [groups, search, sortMode, expanded]);

  const commitAmount = (option: PlannerOption, rawValue: string, recurring = option.recurring) => {
    if (readOnly || option.parentId === undefined && groups.some((group) => group.root.id === option.id && group.children.length > 0)) return;
    const amountMinor = parseAmount(rawValue);
    if (amountMinor === null) return;
    const previous = knownBudget.current[option.id] ?? { amountMinor: option.budgetMinor, recurring: option.recurring };
    if (previous.amountMinor === amountMinor && previous.recurring === recurring) return;
    knownBudget.current[option.id] = { amountMinor, recurring };
    const previousPromise = commitChains.current[option.id] ?? Promise.resolve();
    const nextPromise = previousPromise.catch(() => undefined).then(async () => {
      try {
        const result = await actions.setBudgetAmount(monthKey, option.id, amountMinor, recurring);
        setUndo({
          categoryId: option.id,
          label: option.label,
          amountMinor: previous.amountMinor,
          recurring: previous.recurring,
          revision: result.revision,
        });
        setNotice(null);
      } catch (error) {
        knownBudget.current[option.id] = previous;
        Alert.alert("Couldn't save budget", error instanceof Error ? error.message : "Try again.");
      }
    });
    commitChains.current[option.id] = nextPromise;
  };

  const startDraft = (option: PlannerOption) => {
    if (readOnly || option.parentId === undefined && groups.some((group) => group.root.id === option.id && group.children.length > 0)) return;
    setFocusedIds((current) => ({ ...current, [option.id]: true }));
    setDrafts((current) => ({ ...current, [option.id]: formatRupees(knownBudget.current[option.id]?.amountMinor ?? option.budgetMinor) }));
  };

  const changeDraft = (option: PlannerOption, value: string) => {
    if (readOnly) return;
    setDrafts((current) => ({ ...current, [option.id]: value }));
    if (timers.current[option.id]) clearTimeout(timers.current[option.id]);
    if (parseAmount(value) === null) return;
    timers.current[option.id] = setTimeout(() => commitAmount(option, value), 500);
  };

  const finishDraft = (option: PlannerOption) => {
    if (timers.current[option.id]) clearTimeout(timers.current[option.id]);
    const value = drafts[option.id];
    setFocusedIds((current) => ({ ...current, [option.id]: false }));
    if (value !== undefined) {
      commitAmount(option, value);
      if (parseAmount(value) !== null) setDrafts((current) => ({ ...current, [option.id]: formatRupees(parseAmount(value) ?? 0) }));
      else setDrafts((current) => { const next = { ...current }; delete next[option.id]; return next; });
    }
  };

  const stepAmount = (option: PlannerOption, changeMinor: number) => {
    if (readOnly) return;
    const current = knownBudget.current[option.id]?.amountMinor ?? option.budgetMinor;
    const next = Math.max(0, current + changeMinor);
    commitAmount(option, formatRupees(next));
  };

  const undoLastEdit = async () => {
    if (!undo || undoing || readOnly) return;
    setUndoing(true);
    try {
      await actions.setBudgetAmount(monthKey, undo.categoryId, undo.amountMinor, undo.recurring, undo.revision);
      setUndo(null);
      setNotice("Edit undone");
      knownBudget.current[undo.categoryId] = { amountMinor: undo.amountMinor, recurring: undo.recurring };
    } catch (error) {
      setNotice(error instanceof Error ? "Undo skipped: this row changed" : "Undo skipped");
    } finally {
      setUndoing(false);
    }
  };

  const clearBudget = () => {
    if (readOnly) return;
    Alert.alert("Clear this month's budget?", "All category limits for this month will be removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear budget",
        style: "destructive",
        onPress: async () => {
          try {
            await actions.clearMonthBudget(monthKey);
            setDrafts({});
            setUndo(null);
            setNotice("This month's budget was cleared");
          } catch (error) {
            Alert.alert("Couldn't clear budget", error instanceof Error ? error.message : "Try again.");
          }
        },
      },
    ]);
  };

  const carryForward = async () => {
    if (readOnly || carryForwardBusy) return;
    setCarryForwardBusy(true);
    try {
      const copied = await actions.carryForwardBudget(monthKey);
      setNotice(copied ? `${copied} recurring budget${copied === 1 ? "" : "s"} carried forward` : "Nothing new to carry forward");
    } catch (error) {
      Alert.alert("Couldn't carry forward", error instanceof Error ? error.message : "Try again.");
    } finally {
      setCarryForwardBusy(false);
    }
  };

  const beginRename = (option: PlannerOption) => {
    if (readOnly) return;
    setRenamingId(option.id);
    setRenameDraft(option.label);
  };

  const finishRename = async (option: PlannerOption) => {
    const label = renameDraft.trim();
    setRenamingId(null);
    if (!label || label === option.label || readOnly) return;
    try {
      await actions.renameCategory(option.id, label);
    } catch (error) {
      Alert.alert("Couldn't rename category", error instanceof Error ? error.message : "Try again.");
    }
  };

  const rowHasChildren = (id: string) => groups.some((group) => group.root.id === id && group.children.length > 0);

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.type === "section") return <Text style={styles.sectionTitle}>{item.label}</Text>;
    if (item.type === "group") {
      const members = item.group.children.length > 0 ? item.group.children : [item.group.root];
      const budgetMinor = members.reduce((sum, option) => sum + option.budgetMinor, 0);
      const spentMinor = members.reduce((sum, option) => sum + option.spentMinor, 0);
      const pct = budgetMinor > 0 ? spentMinor / budgetMinor : 0;
      const isAggregate = item.group.children.length > 0;
      return (
        <Pressable
          style={styles.groupRow}
          onPress={() => isAggregate && setExpanded((current) => ({ ...current, [item.group.root.id]: !current[item.group.root.id] }))}
          onLongPress={() => beginRename(item.group.root)}
        >
          <View style={[styles.dot, { backgroundColor: item.group.root.tint }]} />
          <View style={styles.groupCopy}>
            <View style={styles.labelLine}>
              {renamingId === item.group.root.id ? (
                <TextInput
                  value={renameDraft}
                  onChangeText={setRenameDraft}
                  onBlur={() => finishRename(item.group.root)}
                  onSubmitEditing={() => finishRename(item.group.root)}
                  autoFocus
                  style={styles.renameGroupInput}
                />
              ) : <Text style={styles.groupLabel}>{item.group.root.label}</Text>}
              {isAggregate ? <Text style={styles.aggregateTag}>ROLL-UP</Text> : null}
              {isAggregate ? <Text style={styles.chevron}>{expanded[item.group.root.id] ? "⌃" : "⌄"}</Text> : null}
            </View>
            <View style={styles.track}><View style={[styles.fill, { width: `${Math.min(pct, 1) * 100}%`, backgroundColor: pct > 1 ? "#FF8E72" : item.group.root.tint }]} /></View>
            <Text style={styles.meta}>{spendCurrency(spentMinor)} spent {budgetMinor > 0 ? `of ${spendCurrency(budgetMinor)}` : "· no budget"}</Text>
          </View>
          <Text style={styles.groupAmount}>{budgetMinor > 0 ? spendCurrency(budgetMinor) : "—"}</Text>
        </Pressable>
      );
    }
    const option = item.option;
    const value = focusedIds[option.id] ? drafts[option.id] ?? "" : formatRupees(knownBudget.current[option.id]?.amountMinor ?? option.budgetMinor);
    const pct = option.budgetMinor > 0 ? option.spentMinor / option.budgetMinor : 0;
    const delta = option.deltaMinor;
    return (
      <View style={styles.childRow}>
        <View style={[styles.dot, { backgroundColor: option.tint }]} />
        <View style={styles.childCopy}>
          {renamingId === option.id ? (
            <TextInput value={renameDraft} onChangeText={setRenameDraft} onBlur={() => finishRename(option)} onSubmitEditing={() => finishRename(option)} autoFocus style={styles.renameInput} />
          ) : (
            <Pressable onPress={() => beginRename(option)}><Text style={styles.childLabel}>{option.label}</Text></Pressable>
          )}
          <View style={styles.track}><View style={[styles.fill, { width: `${Math.min(pct, 1) * 100}%`, backgroundColor: pct > 1 ? "#FF8E72" : option.tint }]} /></View>
          <Text style={styles.meta}>{spendCurrency(option.spentMinor)} spent {option.budgetMinor > 0 ? `· ${spendCurrency(option.budgetMinor)} budget` : "· no budget"}{delta !== 0 ? ` · ${delta > 0 ? "↑" : "↓"} ${spendCurrency(Math.abs(delta))} vs last month` : ""}</Text>
        </View>
        <View style={styles.amountEditor}>
          <Pressable onPress={() => stepAmount(option, -100)} disabled={readOnly} style={styles.stepper}><Text style={styles.stepperText}>−</Text></Pressable>
          <Text style={styles.currency}>₹</Text>
          <TextInput
            value={value}
            onFocus={() => startDraft(option)}
            onChangeText={(text) => changeDraft(option, text)}
            onBlur={() => finishDraft(option)}
            keyboardType="decimal-pad"
            editable={!readOnly}
            placeholder="0"
            placeholderTextColor="#5C5240"
            style={styles.amountInput}
          />
          <Pressable onPress={() => stepAmount(option, 100)} disabled={readOnly} style={styles.stepper}><Text style={styles.stepperText}>+</Text></Pressable>
        </View>
        <Pressable onPress={() => commitAmount(option, formatRupees(option.budgetMinor), !option.recurring)} disabled={readOnly} style={styles.recurringChip}>
          <Text style={styles.recurringText}>{option.recurring ? "Recurring" : "One-off"}</Text>
        </Pressable>
      </View>
    );
  };

  const totalFromVisibleChildren = plannerOptions.filter((option) => option.parentId).reduce((sum, option) => sum + option.budgetMinor, 0);
  const rootOnlyTotal = plannerOptions.filter((option) => !option.parentId && !rowHasChildren(option.id)).reduce((sum, option) => sum + option.budgetMinor, 0);
  const displayedTotal = totalFromVisibleChildren + rootOnlyTotal;

  const rootOptions = categoryOptions.filter((option) => !option.parentId);
  const confirmAddCategory = async () => {
    const label = newCategoryLabel.trim();
    if (!label) return;
    setCreatingCategory(true);
    try {
      await actions.createCategory(label, newCategoryParentId ? { parentId: newCategoryParentId } : undefined);
      setAddModalVisible(false);
      setNewCategoryLabel("");
      setNewCategoryParentId(null);
    } catch (error) {
      Alert.alert("Couldn't add category", error instanceof Error ? error.message : "Try again.");
    } finally {
      setCreatingCategory(false);
    }
  };

  const listHeader = (
    <View>
      <SpendMonthPager monthKey={monthKey} months={monthChoicesFor(monthKey)} onSelect={setSelectedMonth} />
      <Text style={styles.title}>{spendMonthLabel(monthKey)} budget</Text>
      <Text style={styles.helper}>
        {readOnly ? "Read-only history · actuals and the budget set for this month" : "Limits save as you edit. Parents are aggregate-only roll-ups of their children."}
      </Text>
      <View style={styles.totalCard}>
        <Text style={styles.totalLabel}>MONTHLY TOTAL</Text>
        <Text style={styles.totalAmount}>{spendCurrency(displayedTotal)}</Text>
      </View>
      <View style={styles.actionRow}>
        <Pressable onPress={carryForward} disabled={readOnly || carryForwardBusy} style={styles.actionButton}><Text style={styles.actionText}>{carryForwardBusy ? "Carrying..." : "Carry forward recurring"}</Text></Pressable>
        <Pressable onPress={clearBudget} disabled={readOnly} style={styles.actionButton}><Text style={[styles.actionText, styles.dangerText]}>Clear this month's budget</Text></Pressable>
      </View>
      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>SORT</Text>
        {(["amount", "name", "percent"] as const).map((mode) => <Pressable key={mode} onPress={() => setSortMode(mode)} style={[styles.sortChip, sortMode === mode && styles.sortChipActive]}><Text style={styles.sortText}>{mode === "amount" ? "Amount" : mode === "name" ? "Name" : "% used"}</Text></Pressable>)}
      </View>
      {plannerOptions.length > 12 ? <TextInput value={search} onChangeText={setSearch} placeholder="Search categories" placeholderTextColor="#665B43" style={styles.searchInput} /> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </View>
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <Pressable onPress={() => navigation.goBack()} style={styles.back}><Text style={styles.backText}>‹ Back</Text></Pressable>
      <FlatList
        data={listData}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={<Text style={styles.emptyText}>No categories yet. Add one to start budgeting.</Text>}
        ListFooterComponent={<Pressable onPress={() => setAddModalVisible(true)} style={styles.addRow}><Text style={styles.addPlus}>+</Text><Text style={styles.addText}>Add category</Text></Pressable>}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      />

      {undo ? <Pressable onPress={undoLastEdit} disabled={undoing} style={styles.snackbar}><Text style={styles.snackbarText}>{undoing ? "Undoing..." : `${undo.label} updated`}</Text><Text style={styles.undoText}>UNDO</Text></Pressable> : null}

      <Modal animationType="fade" transparent visible={addModalVisible} onRequestClose={() => setAddModalVisible(false)}>
        <View style={styles.modalBackdrop}><Pressable style={StyleSheet.absoluteFillObject} onPress={() => setAddModalVisible(false)} /><View style={styles.modalSheet}>
          <Text style={styles.modalKicker}>New category</Text><Text style={styles.modalTitle}>Name this category</Text>
          <TextInput ref={addInputRef} value={newCategoryLabel} onChangeText={setNewCategoryLabel} placeholder="Rent, Family, Subscriptions..." placeholderTextColor="#665B43" style={styles.modalInput} autoFocus />
          {rootOptions.length > 0 ? <><Text style={styles.parentLabel}>Add under (optional)</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.parentChipWrap}>
            <Pressable onPress={() => setNewCategoryParentId(null)} style={[styles.parentChip, newCategoryParentId === null && styles.parentChipActive]}><Text style={styles.parentChipText}>None</Text></Pressable>
            {rootOptions.map((option) => <Pressable key={option.id} onPress={() => setNewCategoryParentId(option.id)} style={[styles.parentChip, { borderColor: option.tint }, newCategoryParentId === option.id && styles.parentChipActive]}><Text style={styles.parentChipText}>{option.label}</Text></Pressable>)}
          </ScrollView></> : null}
          <View style={styles.modalActions}><Pressable onPress={() => setAddModalVisible(false)} style={styles.modalButton}><Text style={styles.modalButtonText}>Cancel</Text></Pressable><Pressable onPress={confirmAddCategory} disabled={creatingCategory || !newCategoryLabel.trim()} style={[styles.modalButton, styles.modalButtonPrimary]}><Text style={styles.modalButtonPrimaryText}>{creatingCategory ? "Adding..." : "Add"}</Text></Pressable></View>
        </View></View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#070709", paddingHorizontal: 20 },
  back: { paddingVertical: 8 },
  backText: { color: "#9C8B5C", fontSize: 14 },
  listContent: { paddingBottom: 36 },
  title: { color: "#F5E6B8", fontSize: 23, fontWeight: "500", marginTop: 16 },
  helper: { color: "#9C8B5C", fontSize: 12, lineHeight: 18, marginTop: 6, marginBottom: 14 },
  totalCard: { backgroundColor: "rgba(255,210,122,0.06)", borderColor: "rgba(255,210,122,0.18)", borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 10 },
  totalLabel: { color: "#9C8B5C", fontSize: 10, letterSpacing: 1.6, fontWeight: "600" },
  totalAmount: { color: "#F5E6B8", fontSize: 26, fontWeight: "300", marginTop: 4 },
  actionRow: { gap: 8, marginBottom: 14 },
  actionButton: { borderWidth: 1, borderColor: "rgba(255,210,122,0.20)", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  actionText: { color: "#FFD27A", fontSize: 12, fontWeight: "600" },
  dangerText: { color: "#FF8E72" },
  sortRow: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 10 },
  sortLabel: { color: "#665B43", fontSize: 10, letterSpacing: 1.2, marginRight: 2 },
  sortChip: { borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", borderRadius: 999, paddingVertical: 6, paddingHorizontal: 9 },
  sortChipActive: { backgroundColor: "rgba(255,210,122,0.16)", borderColor: "rgba(255,210,122,0.35)" },
  sortText: { color: "#D8CDB0", fontSize: 11 },
  searchInput: { color: "#F5E6B8", borderWidth: 1, borderColor: "rgba(255,255,255,0.10)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 12 },
  notice: { color: "#FFD27A", fontSize: 12, marginBottom: 10 },
  sectionTitle: { color: "#9C8B5C", fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", marginTop: 14, marginBottom: 5 },
  groupRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1, borderColor: "rgba(255,255,255,0.05)" },
  groupCopy: { flex: 1, marginRight: 10 },
  labelLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  groupLabel: { color: "#D8CDB0", fontSize: 15, fontWeight: "600" },
  aggregateTag: { color: "#665B43", fontSize: 9, letterSpacing: 0.8 },
  chevron: { color: "#9C8B5C", fontSize: 16, marginLeft: "auto" },
  groupAmount: { color: "#F5E6B8", fontSize: 14, minWidth: 60, textAlign: "right" },
  childRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingLeft: 20, borderBottomWidth: 1, borderColor: "rgba(255,255,255,0.04)" },
  childCopy: { flex: 1, marginRight: 8 },
  childLabel: { color: "#D8CDB0", fontSize: 13 },
  renameInput: { color: "#F5E6B8", borderBottomWidth: 1, borderColor: "#FFD27A", paddingVertical: 2, fontSize: 13 },
  renameGroupInput: { color: "#F5E6B8", borderBottomWidth: 1, borderColor: "#FFD27A", paddingVertical: 1, fontSize: 15, minWidth: 100 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  track: { height: 6, borderRadius: 5, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.08)", marginTop: 7 },
  fill: { height: "100%", borderRadius: 5 },
  meta: { color: "#8F8F96", fontSize: 10, marginTop: 5 },
  amountEditor: { flexDirection: "row", alignItems: "center" },
  currency: { color: "#7A6B41", fontSize: 13 },
  amountInput: { color: "#F5E6B8", fontSize: 15, minWidth: 52, paddingVertical: 5, paddingHorizontal: 2, textAlign: "right" },
  stepper: { paddingHorizontal: 4, paddingVertical: 5 },
  stepperText: { color: "#FFD27A", fontSize: 18 },
  recurringChip: { marginLeft: 8, borderRadius: 999, backgroundColor: "rgba(255,210,122,0.10)", paddingVertical: 5, paddingHorizontal: 7 },
  recurringText: { color: "#9C8B5C", fontSize: 9 },
  addRow: { flexDirection: "row", alignItems: "center", paddingVertical: 18 },
  addPlus: { color: "#FFD27A", fontSize: 18, width: 22, textAlign: "center" },
  addText: { color: "#FFD27A", fontSize: 14, fontWeight: "500" },
  emptyText: { color: "rgba(255,255,255,0.5)", fontSize: 13, paddingVertical: 16 },
  snackbar: { position: "absolute", left: 20, right: 20, bottom: 22, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 15, backgroundColor: "#1A1711", borderWidth: 1, borderColor: "rgba(255,210,122,0.35)", flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  snackbarText: { color: "#D8CDB0", fontSize: 12 },
  undoText: { color: "#FFD27A", fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: "#0E0C0A", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, paddingBottom: 32, borderTopWidth: 1, borderColor: "rgba(245,230,184,0.10)" },
  modalKicker: { color: "#9C8B5C", fontSize: 11, letterSpacing: 1.6, fontWeight: "600", textTransform: "uppercase" },
  modalTitle: { color: "#F5E6B8", fontSize: 20, fontWeight: "500", marginTop: 6 },
  modalInput: { color: "#F5E6B8", fontSize: 14, backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: "rgba(245,230,184,0.10)", marginTop: 14 },
  parentLabel: { color: "#9C8B5C", fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", marginTop: 18, marginBottom: 8 },
  parentChipWrap: { gap: 8, paddingRight: 8 },
  parentChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.04)" },
  parentChipActive: { backgroundColor: "rgba(255,210,122,0.18)" },
  parentChipText: { color: "#D8CDB0", fontSize: 12 },
  modalActions: { flexDirection: "row", gap: 8, marginTop: 18, justifyContent: "flex-end" },
  modalButton: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.04)", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  modalButtonText: { color: "#D8CDB0", fontSize: 13 },
  modalButtonPrimary: { backgroundColor: "#FFD27A", borderColor: "#FFD27A" },
  modalButtonPrimaryText: { color: "#070709", fontSize: 13, fontWeight: "600" },
});
