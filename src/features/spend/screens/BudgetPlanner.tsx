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
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons";
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
    availableMonths,
  } = useSpend();
  const monthKey = selectedMonth;
  const monthLabel = spendMonthLabel(monthKey);
  const currentMonth = accountingMonthKey();
  const readOnly = monthKey < currentMonth;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sortMode, setSortMode] = useState<SortMode>("amount");
  const [search, setSearch] = useState("");
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
  const [newCategoryAmount, setNewCategoryAmount] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [carryForwardBusy, setCarryForwardBusy] = useState(false);
  const [editing, setEditing] = useState<PlannerOption | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editRecurring, setEditRecurring] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const editAmountRef = useRef<TextInput>(null);
  const addInputRef = useRef<TextInput>(null);
  const addAmountRef = useRef<TextInput>(null);
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

  // Categories that exist but are not in this month. Removing one from a month
  // must not mean retyping its name to bring it back — and typing a name that
  // already exists resolves to that category rather than creating a twin.
  const notInThisMonth = useMemo(
    () => plannerOptions
      .filter((option) => option.budgetMinor === 0)
      .sort((left, right) => left.label.localeCompare(right.label)),
    [plannerOptions],
  );

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
            // A category is IN a month when it has a budget line there. Listing
            // every category that has ever existed is what made this screen a
            // wall of mostly-empty rows, and it is why "remove" appeared to do
            // nothing: the amount cleared, the row stayed.
            return inSection && child.budgetMinor > 0 && (!query || matchesRoot || child.label.toLowerCase().includes(query));
          });
          const rootIsMember = group.children.length === 0 && group.root.budgetMinor > 0
            && (section === "recurring" ? group.root.recurring : !group.root.recurring);
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



  const rowHasChildren = (id: string) => groups.some((group) => group.root.id === id && group.children.length > 0);

  const openEditor = (option: PlannerOption) => {
    if (readOnly) return;
    setEditing(option);
    setEditLabel(option.label);
    setEditAmount(option.budgetMinor > 0 ? formatRupees(option.budgetMinor) : "");
    setEditRecurring(option.recurring);
  };

  const closeEditor = () => {
    if (savingEdit) return;
    setEditing(null);
  };

  const saveEditor = async () => {
    if (!editing || savingEdit) return;
    const label = editLabel.trim();
    const amountMinor = editAmount.trim() === "" ? 0 : parseAmount(editAmount);
    if (amountMinor === null) {
      Alert.alert("Enter a valid amount", "Use digits only, for example 2500 or 2500.50.");
      return;
    }
    setSavingEdit(true);
    try {
      if (label && label !== editing.label) {
        await actions.renameCategory(editing.id, label);
      }
      if (amountMinor !== editing.budgetMinor || editRecurring !== editing.recurring) {
        await actions.setBudgetAmount(monthKey, editing.id, amountMinor, editRecurring);
        knownBudget.current[editing.id] = { amountMinor, recurring: editRecurring };
      }
      setEditing(null);
    } catch (error) {
      Alert.alert("Couldn't save", error instanceof Error ? error.message : "Try again.");
    } finally {
      setSavingEdit(false);
    }
  };

  /**
   * Removing a budget clears it for THIS month only. Archiving the category
   * instead would take its budget line out of every month, including months
   * already closed — a past month is a record, not something an edit today
   * should rewrite. The category itself survives so it can be budgeted again.
   */
  const removeFromMonth = () => {
    if (!editing || savingEdit) return;
    const option = editing;
    Alert.alert(
      `Remove ${option.label}?`,
      `Its budget will be cleared for ${monthLabel} only. Earlier months keep theirs, and the category stays available.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setSavingEdit(true);
            try {
              await actions.setBudgetAmount(monthKey, option.id, 0, false);
              knownBudget.current[option.id] = { amountMinor: 0, recurring: false };
              setEditing(null);
            } catch (error) {
              Alert.alert("Couldn't remove", error instanceof Error ? error.message : "Try again.");
            } finally {
              setSavingEdit(false);
            }
          },
        },
      ],
    );
  };

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.type === "section") return <Text style={styles.sectionTitle}>{item.label}</Text>;

    if (item.type === "group") {
      const root = item.group.root;
      const members = item.group.children.length > 0 ? item.group.children : [root];
      const budgetMinor = members.reduce((sum, option) => sum + option.budgetMinor, 0);
      const spentMinor = members.reduce((sum, option) => sum + option.spentMinor, 0);
      const pct = budgetMinor > 0 ? spentMinor / budgetMinor : 0;
      const isAggregate = item.group.children.length > 0;

      // A parent row expands. Everything else is a single tap target that opens
      // the editor sheet — no in-place text fields anywhere in the list.
      return (
        <Pressable
          style={styles.groupRow}
          onPress={() =>
            isAggregate
              ? setExpanded((current) => ({ ...current, [root.id]: !current[root.id] }))
              : openEditor(root)
          }
        >
          <View style={[styles.dot, { backgroundColor: root.tint }]} />
          <View style={styles.groupCopy}>
            <View style={styles.labelLine}>
              <Text style={styles.groupLabel}>{root.label}</Text>
              {isAggregate ? <Text style={styles.aggregateTag}>ROLL-UP</Text> : null}
              {isAggregate ? (
                <MaterialCommunityIcons
                  name={expanded[root.id] ? "chevron-up" : "chevron-down"}
                  size={18}
                  color="#9C8B5C"
                />
              ) : null}
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.min(pct, 1) * 100}%`, backgroundColor: pct > 1 ? "#FF8E72" : root.tint }]} />
            </View>
            <Text style={styles.meta}>
              {spendCurrency(spentMinor)} spent {budgetMinor > 0 ? `of ${spendCurrency(budgetMinor)}` : "· no budget"}
              {!isAggregate && root.recurring ? " · recurring" : ""}
            </Text>
          </View>
          <View style={styles.amountBlock}>
            <Text style={styles.amountValue}>{budgetMinor > 0 ? spendCurrency(budgetMinor) : "Set"}</Text>
          </View>
        </Pressable>
      );
    }

    const option = item.option;
    const pct = option.budgetMinor > 0 ? option.spentMinor / option.budgetMinor : 0;
    const delta = option.deltaMinor;
    return (
      <Pressable style={styles.childRow} onPress={() => openEditor(option)}>
        <View style={[styles.dot, { backgroundColor: option.tint }]} />
        <View style={styles.childCopy}>
          <Text style={styles.childLabel}>{option.label}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.min(pct, 1) * 100}%`, backgroundColor: pct > 1 ? "#FF8E72" : option.tint }]} />
          </View>
          <Text style={styles.meta}>
            {spendCurrency(option.spentMinor)} spent {option.budgetMinor > 0 ? `· ${spendCurrency(option.budgetMinor)} budget` : "· no budget"}
            {option.recurring ? " · recurring" : ""}
            {delta !== 0 ? ` · ${delta > 0 ? "↑" : "↓"} ${spendCurrency(Math.abs(delta))} vs last month` : ""}
          </Text>
        </View>
        <View style={styles.amountBlock}>
          <Text style={styles.amountValue}>{option.budgetMinor > 0 ? spendCurrency(option.budgetMinor) : "Set"}</Text>
        </View>
      </Pressable>
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
      const created = await actions.createCategory(label, newCategoryParentId ? { parentId: newCategoryParentId } : undefined);
      // Setting the amount here saves a second trip: naming a category and
      // deciding what it is worth are the same thought.
      const amountMinor = parseAmount(newCategoryAmount);
      if (amountMinor !== null && amountMinor > 0 && created?.id) {
        await actions.setBudgetAmount(monthKey, created.id, amountMinor, false);
      }
      setAddModalVisible(false);
      setNewCategoryLabel("");
      setNewCategoryParentId(null);
      setNewCategoryAmount("");
    } catch (error) {
      Alert.alert("Couldn't add category", error instanceof Error ? error.message : "Try again.");
    } finally {
      setCreatingCategory(false);
    }
  };

  const listHeader = (
    <View>
      <SpendMonthPager monthKey={monthKey} months={availableMonths} onSelect={setSelectedMonth} />
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

      <Modal
        animationType="slide"
        transparent
        visible={editing !== null}
        onRequestClose={closeEditor}
        onShow={() => setTimeout(() => editAmountRef.current?.focus(), 60)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeEditor} />
          <View style={styles.editSheet}>
            <View style={styles.sheetGrip} />
            <Text style={styles.modalKicker}>Edit category</Text>

            <Text style={styles.fieldLabel}>Category</Text>
            <TextInput
              value={editLabel}
              onChangeText={setEditLabel}
              placeholder="Category name"
              placeholderTextColor="#665B43"
              style={styles.modalInput}
              returnKeyType="next"
              onSubmitEditing={() => editAmountRef.current?.focus()}
            />

            <Text style={styles.fieldLabel}>Monthly amount</Text>
            <View style={styles.modalAmountRow}>
              <Text style={styles.modalCurrency}>₹</Text>
              <TextInput
                ref={editAmountRef}
                value={editAmount}
                onChangeText={setEditAmount}
                placeholder="0"
                placeholderTextColor="#665B43"
                keyboardType="decimal-pad"
                style={styles.modalAmountInput}
                returnKeyType="done"
                onSubmitEditing={saveEditor}
              />
            </View>

            <Pressable onPress={() => setEditRecurring((value) => !value)} style={styles.recurringToggle}>
              <MaterialCommunityIcons
                name={editRecurring ? "checkbox-marked" : "checkbox-blank-outline"}
                size={20}
                color={editRecurring ? "#FFD27A" : "#6D6048"}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.recurringToggleLabel}>Recurring</Text>
                <Text style={styles.recurringToggleHint}>Carries forward to next month. One-offs do not.</Text>
              </View>
            </Pressable>

            {editing && editing.budgetMinor > 0 ? (
              <Pressable onPress={removeFromMonth} disabled={savingEdit} style={styles.removeRow}>
                <MaterialCommunityIcons name="calendar-remove-outline" size={18} color="#FF8A80" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.removeText}>Remove from {monthLabel}</Text>
                  <Text style={styles.removeHint}>Other months keep it. Add it back any time.</Text>
                </View>
              </Pressable>
            ) : null}


            <View style={styles.modalActions}>
              <Pressable onPress={closeEditor} style={styles.modalButton}>
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={saveEditor} disabled={savingEdit} style={[styles.modalButton, styles.modalButtonPrimary]}>
                <Text style={styles.modalButtonPrimaryText}>{savingEdit ? "Saving..." : "Save"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        transparent
        visible={addModalVisible}
        onRequestClose={() => setAddModalVisible(false)}
        onShow={() => setTimeout(() => addInputRef.current?.focus(), 60)}
      >
        <View style={styles.modalBackdrop}><Pressable style={StyleSheet.absoluteFillObject} onPress={() => setAddModalVisible(false)} /><View style={styles.modalSheet}>
          <Text style={styles.modalKicker}>Add to {monthLabel}</Text><Text style={styles.modalTitle}>Name this category</Text>
          {notInThisMonth.length > 0 ? (
            <>
              <Text style={styles.parentLabel}>Not in {monthLabel} yet</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.parentChipWrap}>
                {notInThisMonth.map((option) => (
                  <Pressable
                    key={option.id}
                    onPress={() => {
                      setNewCategoryLabel(option.label);
                      setNewCategoryParentId(option.parentId ?? null);
                      setTimeout(() => addAmountRef.current?.focus(), 40);
                    }}
                    style={[styles.parentChip, { borderColor: option.tint }, newCategoryLabel === option.label && styles.parentChipActive]}
                  >
                    <Text style={styles.parentChipText}>{option.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          ) : null}
          <TextInput
            ref={addInputRef}
            value={newCategoryLabel}
            onChangeText={setNewCategoryLabel}
            placeholder="Rent, Family, Subscriptions..."
            placeholderTextColor="#665B43"
            style={styles.modalInput}
            returnKeyType="next"
            onSubmitEditing={() => addAmountRef.current?.focus()}
          />
          <Text style={styles.parentLabel}>Monthly amount</Text>
          <View style={styles.modalAmountRow}>
            <Text style={styles.modalCurrency}>₹</Text>
            <TextInput
              ref={addAmountRef}
              value={newCategoryAmount}
              onChangeText={setNewCategoryAmount}
              placeholder="0"
              placeholderTextColor="#665B43"
              keyboardType="decimal-pad"
              style={styles.modalAmountInput}
              returnKeyType="done"
              onSubmitEditing={confirmAddCategory}
            />
          </View>
          {rootOptions.length > 0 ? <><Text style={styles.parentLabel}>Add under (optional)</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.parentChipWrap}>
            <Pressable onPress={() => setNewCategoryParentId(null)} style={[styles.parentChip, newCategoryParentId === null && styles.parentChipActive]}><Text style={styles.parentChipText}>None</Text></Pressable>
            {rootOptions.map((option) => <Pressable key={option.id} onPress={() => setNewCategoryParentId(option.id)} style={[styles.parentChip, { borderColor: option.tint }, newCategoryParentId === option.id && styles.parentChipActive]}><Text style={styles.parentChipText}>{option.label}</Text></Pressable>)}
          </ScrollView></> : null}
          <View style={styles.modalActions}><Pressable onPress={() => { setAddModalVisible(false); setNewCategoryAmount(""); }} style={styles.modalButton}><Text style={styles.modalButtonText}>Cancel</Text></Pressable><Pressable onPress={confirmAddCategory} disabled={creatingCategory || !newCategoryLabel.trim()} style={[styles.modalButton, styles.modalButtonPrimary]}><Text style={styles.modalButtonPrimaryText}>{creatingCategory ? "Adding..." : "Add"}</Text></Pressable></View>
        </View></View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  amountBlock: { flexDirection: "row", alignItems: "center", gap: 6 },
  amountValue: { color: "#F5E6B8", fontSize: 17, fontWeight: "600" },
  editSheet: {
    backgroundColor: "#0E0C0A", borderTopLeftRadius: 26, borderTopRightRadius: 26,
    borderTopWidth: 1, borderColor: "rgba(245,230,184,0.12)",
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 30,
  },
  sheetGrip: { width: 42, height: 4, borderRadius: 2, backgroundColor: "#6D6048", alignSelf: "center", marginBottom: 18 },
  fieldLabel: { color: "#9C8B5C", fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700", marginTop: 16, marginBottom: 6 },
  recurringToggle: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 20 },
  removeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22, paddingVertical: 6 },
  removeText: { color: "#FFB74D", fontSize: 14, fontWeight: "500" },
  removeHint: { color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 2 },
  recurringToggleLabel: { color: "#D8CDB0", fontSize: 15, fontWeight: "600" },
  recurringToggleHint: { color: "#6D6048", fontSize: 12, marginTop: 2 },
  modalAmountRow: {
    flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6,
    borderWidth: 1, borderColor: "rgba(245,230,184,0.12)", borderRadius: 12,
    paddingHorizontal: 14, backgroundColor: "rgba(255,255,255,0.04)",
  },
  modalCurrency: { color: "#7A6B41", fontSize: 16 },
  modalAmountInput: { flex: 1, color: "#F5E6B8", fontSize: 17, paddingVertical: 12 },
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
