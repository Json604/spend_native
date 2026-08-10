import { useEffect, useMemo, useState } from "react";
import {
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons";

import { useSpend } from "../store/SpendProvider";
import { useAuth } from "../../../auth/AuthProvider";
import { accountingMonthKey, previousAccountingMonthKey, spendMonthLabel } from "../store/sqliteRepository";
import SpendTodayHeroCard from "../components/SpendTodayHeroCard";
import SpendBudgetCard from "../components/SpendBudgetCard";
import SpendDayTransactionsCard from "../components/SpendDayTransactionsCard";
import SpendCategoryCard from "../components/SpendCategoryCard";
import SpendDailyBarsCard from "../components/SpendDailyBarsCard";
import SpendNeedsReviewCard from "../components/SpendNeedsReviewCard";
import SpendMonthPager from "../components/SpendMonthPager";
import { SpendScreenSkeleton } from "../components/SpendSkeleton";
import { categoriesForMonthlyBudget } from "../store/budgetSelectors";

export default function SpendMain() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const {
    domain,
    summary,
    categories,
    categoryOptions,
    reviewItems,
    reviewPreview,
    widgetSnapshot,
    currentMonthBudget,
    selectedMonth,
    setSelectedMonth,
    availableMonths,
    getTransactionsForDay,
    dailyBuckets,
    dataRevision,
    hydrating,
    actions,
  } = useSpend();
  const { user } = useAuth();

  const [refreshing, setRefreshing] = useState(false);
  const [reviewModalVisible, setReviewModalVisible] = useState(false);
  const [selectedReviewTransactionId, setSelectedReviewTransactionId] = useState<string | null>(null);
  const [customCategory, setCustomCategory] = useState("");
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [selectedBucketDate, setSelectedBucketDate] = useState<string | null>(null);
  const [reviewCustomParentId, setReviewCustomParentId] = useState<string | null>(null);
  const [splitModalVisible, setSplitModalVisible] = useState(false);
  const [splitTransactionId, setSplitTransactionId] = useState<string | null>(null);
  const [splitRows, setSplitRows] = useState<Array<{categoryId: string; amount: string}>>([
    {categoryId: "", amount: ""},
    {categoryId: "", amount: ""},
  ]);
  const [splitError, setSplitError] = useState<string | null>(null);

  const reviewCategoryOptions = useMemo(() => {
    return categoriesForMonthlyBudget(
      categoryOptions,
      currentMonthBudget?.categoryBudgets,
    );
  }, [categoryOptions, currentMonthBudget]);

  const reviewRootOptions = useMemo(
    () =>
      reviewCategoryOptions
        .filter((opt) => !opt.parentId)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [reviewCategoryOptions],
  );

  const activeBucket = useMemo(() => {
    if (selectedBucketDate) {
      return dailyBuckets.find((b) => b.date === selectedBucketDate) ?? null;
    }
    return dailyBuckets.find((b) => b.isToday) ?? null;
  }, [dailyBuckets, selectedBucketDate]);

  const [dayTransactions, setDayTransactions] = useState<typeof domain.state.transactions>([]);

  useEffect(() => {
    if (!activeBucket) {
      setDayTransactions([]);
      return;
    }
    getTransactionsForDay(activeBucket.date)
      .then(setDayTransactions)
      .catch(() => setDayTransactions([]));
    // dataRevision, not a transaction count: recategorising or editing a spend
    // leaves the count identical, so counting alone left this list showing stale
    // rows until the app was restarted.
  }, [activeBucket?.date, getTransactionsForDay, dataRevision]);

  const monthName = useMemo(() => spendMonthLabel(selectedMonth), [selectedMonth]);

  // Only stand in for content that genuinely has not arrived. Showing skeletons
  // over data the user can already read is worse than showing nothing.
  const showSkeletons = hydrating && domain.state.transactions.length === 0;

  // Deep-link routing
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      if (url.startsWith("lym://spend/add")) {
        navigation.navigate("SpendManualEntry");
      } else if (url.startsWith("lym://spend/budget")) {
        navigation.navigate("SpendBudgetPlanner");
      } else if (url.startsWith("lym://spend/split/")) {
        const transactionId = decodeURIComponent(url.slice("lym://spend/split/".length));
        if (transactionId) openSplitModal(transactionId);
      }
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, [navigation]);

  const onPullToRefresh = async () => {
    setRefreshing(true);
    try {
      await actions.refreshSmsInbox();
    } finally {
      setRefreshing(false);
    }
  };

  const activeReviewItem =
    reviewItems.find((item) => item.transactionId === selectedReviewTransactionId) ?? reviewItems[0];
  const splitReviewItem = reviewItems.find((item) => item.transactionId === splitTransactionId);

  const openSplitModal = (transactionId: string) => {
    setSplitTransactionId(transactionId);
    setSplitRows([{categoryId: "", amount: ""}, {categoryId: "", amount: ""}]);
    setSplitError(null);
    setReviewModalVisible(false);
    setSplitModalVisible(true);
  };

  const closeSplitModal = () => {
    if (isSavingReview) return;
    setSplitModalVisible(false);
    setSplitTransactionId(null);
    setSplitError(null);
  };

  const parsedSplitRows = splitRows.map((row) => {
    const amount = Number(row.amount || "0");
    return {
      categoryId: row.categoryId,
      amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : 0,
    };
  });
  const splitAssignedMinor = parsedSplitRows.reduce((sum, row) => sum + row.amountMinor, 0);
  const splitRemainingMinor = (splitReviewItem?.amountMinor ?? 0) - splitAssignedMinor;
  const splitCategoriesUnique = new Set(parsedSplitRows.map((row) => row.categoryId)).size === parsedSplitRows.length;
  const canSaveSplit = Boolean(
    splitReviewItem &&
    splitRows.length >= 2 &&
    parsedSplitRows.every((row) => row.categoryId && row.amountMinor > 0) &&
    splitCategoriesUnique &&
    splitRemainingMinor === 0,
  );

  const saveSplit = async () => {
    if (!splitReviewItem || !canSaveSplit) return;
    setIsSavingReview(true);
    setSplitError(null);
    try {
      await actions.splitTransaction(
        splitReviewItem.transactionId,
        parsedSplitRows.map((row) => ({categoryId: row.categoryId as any, amountMinor: row.amountMinor})),
      );
      setSplitModalVisible(false);
      setSplitTransactionId(null);
    } catch (error) {
      setSplitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingReview(false);
    }
  };

  const openReviewModal = (transactionId?: string) => {
    const next = transactionId ?? reviewItems[0]?.transactionId;
    if (!next) return;
    setSelectedReviewTransactionId(next);
    setCustomCategory("");
    setReviewCustomParentId(null);
    setReviewModalVisible(true);
  };

  const closeReviewModal = () => {
    if (isSavingReview) return;
    setReviewModalVisible(false);
    setSelectedReviewTransactionId(null);
    setCustomCategory("");
    setReviewCustomParentId(null);
  };

  const assignCategory = async (
    categoryLabel: string,
    opts?: { parentId?: string; isNewCustom?: boolean },
  ) => {
    if (!activeReviewItem) return;
    setIsSavingReview(true);
    try {
      const forwardOpts =
        opts?.isNewCustom && opts.parentId
          ? { parentId: opts.parentId as any }
          : undefined;
      await actions.assignReviewCategory(
        activeReviewItem.transactionId,
        categoryLabel,
        forwardOpts,
      );
      setReviewModalVisible(false);
      setSelectedReviewTransactionId(null);
      setCustomCategory("");
      setReviewCustomParentId(null);
    } finally {
      setIsSavingReview(false);
    }
  };

  const ignoreReviewTransaction = async (transactionId: string) => {
    setIsSavingReview(true);
    try {
      await actions.ignoreTransaction(transactionId);
      if (selectedReviewTransactionId === transactionId) {
        setReviewModalVisible(false);
        setSelectedReviewTransactionId(null);
      }
    } finally {
      setIsSavingReview(false);
    }
  };

  const saveCustomCategory = async () => {
    const trimmed = customCategory.trim();
    if (!trimmed) return;
    await assignCategory(trimmed, {
      parentId: reviewCustomParentId ?? undefined,
      isNewCustom: true,
    });
  };

  return (
    <View style={styles.page}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + 18,
            paddingBottom: Math.max(insets.bottom + 120, 140),
          },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onPullToRefresh}
            tintColor="#FFD27A"
            colors={["#FFD27A"]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleRow}>
          <Text style={styles.pageTitle}>Spend</Text>
          <Pressable
            accessibilityLabel={user ? "Open profile" : "Sign in"}
            onPress={() => navigation.navigate(user ? "Profile" : "SignIn")}
            style={styles.accountButton}
          >
            <MaterialCommunityIcons name={user ? "account-circle-outline" : "account-outline"} size={20} color="#FFD27A" />
            <Text style={styles.accountButtonText}>{user ? "Profile" : "Sign in"}</Text>
          </Pressable>
        </View>

        <SpendMonthPager monthKey={selectedMonth} months={availableMonths} onSelect={setSelectedMonth} />
        {selectedMonth < accountingMonthKey() ? (
          <Text style={styles.readOnlyHint}>{monthName} is read-only. Actuals and the budget set for that month are preserved.</Text>
        ) : null}

        {domain.state.syncStates.find((s) => s.source === "sms")?.status === "needs_permission" ? (
          <Pressable
            onPress={() => actions.grantSmsAccess()}
            style={{
              backgroundColor: "rgba(255,210,122,0.12)",
              borderColor: "rgba(255,210,122,0.3)",
              borderWidth: 1,
              borderRadius: 12,
              paddingVertical: 12,
              paddingHorizontal: 14,
              marginBottom: 14,
            }}
          >
            <Text style={{ color: "#FFD27A", fontWeight: "500" }}>
              Grant SMS access to start tracking
            </Text>
          </Pressable>
        ) : null}

        {showSkeletons ? <SpendScreenSkeleton /> : (
        <>
        <View style={styles.cardSlot}>
          <SpendTodayHeroCard todayFormatted={widgetSnapshot.todayFormatted} />
        </View>

        <View style={styles.cardSlot}>
          <SpendBudgetCard
            monthName={monthName}
            budget={currentMonthBudget}
            spentMinor={widgetSnapshot.monthSpentMinor}
            onSet={() => navigation.navigate("SpendBudgetPlanner")}
          />
        </View>

        <View style={styles.cardSlot}>
          <SpendDailyBarsCard
            buckets={dailyBuckets}
            selectedDate={selectedBucketDate}
            onSelectDate={setSelectedBucketDate}
          />
        </View>

        <View style={styles.cardSlot}>
          <SpendDayTransactionsCard
            dayLabel={activeBucket?.fullLabel ?? "Today"}
            isToday={!!activeBucket?.isToday}
            transactions={dayTransactions}
            categoryOptions={categoryOptions}
            onAssignCategory={(id, label, opts) =>
              actions.assignReviewCategory(id, label, opts)
            }
            onDeleteTransaction={(id) => actions.ignoreTransaction(id)}
            onSetPlanType={(id, planType) => actions.setTransactionPlanType(id, planType)}
          />
        </View>

        <View style={styles.cardSlot}>
          <SpendCategoryCard categories={categories} />
        </View>

        {reviewItems.length > 0 ? (
          <View style={styles.cardSlot}>
            <SpendNeedsReviewCard
              reviewPreview={reviewPreview}
              reviewItems={reviewItems}
              pendingCount={reviewItems.length}
              onSelectReview={openReviewModal}
              onIgnoreReview={ignoreReviewTransaction}
              onSplitReview={openSplitModal}
            />
          </View>
        ) : null}
        </>
        )}
      </ScrollView>

      {/* FAB */}
      <Pressable
        accessibilityLabel="Add transaction"
        onPress={() =>
          navigation.navigate("SpendManualEntry", {
            forDate: activeBucket?.date,
          })
        }
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
      >
        <MaterialCommunityIcons name="plus" size={26} color="#061018" />
      </Pressable>

      <Modal
        animationType="fade"
        transparent
        visible={reviewModalVisible}
        onRequestClose={closeReviewModal}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeReviewModal} />
          <View style={[styles.modalSheet, { paddingBottom: Math.max(insets.bottom + 24, 32) }]}>
            <Text style={styles.modalKicker}>Review payment</Text>
            <Text style={styles.modalTitle}>{activeReviewItem?.payee ?? "Pending"}</Text>
            <Text style={styles.modalMeta}>
              {[activeReviewItem?.amountLabel, activeReviewItem?.occurredAtLabel]
                .filter(Boolean)
                .join("  •  ")}
            </Text>
            <Text style={styles.modalHint}>
              Pick a category or type your own. Future payments to the same payee reuse it.
            </Text>

            {activeReviewItem ? (
              <Pressable
                disabled={isSavingReview}
                onPress={() => openSplitModal(activeReviewItem.transactionId)}
                style={styles.splitEntryButton}
              >
                <MaterialCommunityIcons name="call-split" size={17} color="#FFD27A" />
                <Text style={styles.splitEntryText}>Split across categories</Text>
              </Pressable>
            ) : null}

            <View style={styles.optionWrap}>
              {reviewCategoryOptions.map((option) => (
                <Pressable
                  key={option.id}
                  disabled={isSavingReview}
                  onPress={() => assignCategory(option.label)}
                  style={({ pressed }) => [
                    styles.optionChip,
                    { borderColor: option.tint },
                    pressed && styles.optionChipPressed,
                  ]}
                >
                  <View style={[styles.optionDot, { backgroundColor: option.tint }]} />
                  <Text style={styles.optionLabel}>{option.label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.inputLabel}>Or add your own</Text>
            <TextInput
              value={customCategory}
              onChangeText={setCustomCategory}
              placeholder="Rent, Friend repayment, Family..."
              placeholderTextColor="rgba(180,220,240,0.35)"
              style={styles.input}
              editable={!isSavingReview}
            />

            {reviewRootOptions.length > 0 ? (
              <>
                <Text style={styles.inputLabel}>Add under (optional)</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.parentChipWrap}
                  keyboardShouldPersistTaps="handled"
                >
                  <Pressable
                    onPress={() => setReviewCustomParentId(null)}
                    style={[
                      styles.parentChip,
                      reviewCustomParentId === null && styles.parentChipActive,
                    ]}
                  >
                    <Text style={styles.parentChipText}>None</Text>
                  </Pressable>
                  {reviewRootOptions.map((opt) => {
                    const active = reviewCustomParentId === opt.id;
                    return (
                      <Pressable
                        key={opt.id}
                        onPress={() => setReviewCustomParentId(opt.id)}
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

            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalBtn}
                onPress={() =>
                  activeReviewItem ? ignoreReviewTransaction(activeReviewItem.transactionId) : undefined
                }
              >
                <Text style={styles.modalBtnText}>{isSavingReview ? "Working..." : "Don't add"}</Text>
              </Pressable>
              <Pressable style={styles.modalBtn} onPress={closeReviewModal}>
                <Text style={styles.modalBtnText}>Later</Text>
              </Pressable>
              <Pressable style={[styles.modalBtn, styles.modalBtnPrimary]} onPress={saveCustomCategory}>
                <Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>
                  {isSavingReview ? "Saving..." : "Save"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent visible={splitModalVisible} onRequestClose={closeSplitModal}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeSplitModal} />
          <View style={[styles.modalSheet, {paddingBottom: Math.max(insets.bottom + 20, 28)}]}>
            <Text style={styles.modalKicker}>Split payment</Text>
            <Text style={styles.modalTitle}>{splitReviewItem?.payee ?? "Transaction"}</Text>
            <Text style={styles.modalMeta}>{splitReviewItem?.amountLabel}</Text>
            <ScrollView style={styles.splitScroll} keyboardShouldPersistTaps="handled">
              {splitRows.map((row, rowIndex) => (
                <View key={rowIndex} style={styles.splitRow}>
                  <Text style={styles.inputLabel}>Category {rowIndex + 1}</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.splitCategoryChoices}>
                    {reviewCategoryOptions.map((option) => (
                      <Pressable
                        key={option.id}
                        onPress={() => setSplitRows((current) => current.map((item, index) => index === rowIndex ? {...item, categoryId: option.id} : item))}
                        style={[styles.optionChip, {borderColor: option.tint}, row.categoryId === option.id && styles.splitCategorySelected]}
                      >
                        <Text style={styles.optionLabel}>{option.label}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                  <TextInput
                    keyboardType="decimal-pad"
                    onChangeText={(amount) => setSplitRows((current) => current.map((item, index) => index === rowIndex ? {...item, amount} : item))}
                    placeholder="Amount in ₹"
                    placeholderTextColor="rgba(180,220,240,0.35)"
                    style={styles.input}
                    value={row.amount}
                  />
                  {splitRows.length > 2 ? (
                    <Pressable onPress={() => setSplitRows((current) => current.filter((_, index) => index !== rowIndex))}>
                      <Text style={styles.removeSplitText}>Remove row</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
              <Pressable onPress={() => setSplitRows((current) => [...current, {categoryId: "", amount: ""}])} style={styles.addSplitButton}>
                <Text style={styles.addSplitText}>+ Add another category</Text>
              </Pressable>
            </ScrollView>
            <Text style={[styles.splitBalance, splitRemainingMinor !== 0 && styles.splitBalancePending]}>
              {splitRemainingMinor === 0
                ? "Fully allocated"
                : splitRemainingMinor > 0
                  ? `₹${(splitRemainingMinor / 100).toFixed(2)} left to assign`
                  : `₹${(Math.abs(splitRemainingMinor) / 100).toFixed(2)} over the transaction total`}
            </Text>
            {!splitCategoriesUnique ? <Text style={styles.splitError}>Choose each category only once.</Text> : null}
            {splitError ? <Text style={styles.splitError}>{splitError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable onPress={closeSplitModal} style={styles.cancelButton}><Text style={styles.cancelButtonText}>Cancel</Text></Pressable>
              <Pressable disabled={!canSaveSplit || isSavingReview} onPress={saveSplit} style={[styles.saveButton, (!canSaveSplit || isSavingReview) && styles.saveButtonDisabled]}>
                <Text style={styles.saveButtonText}>{isSavingReview ? "Saving…" : "Save split"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#070709" },
  content: { paddingHorizontal: 18 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  readOnlyHint: { color: "#9C8B5C", fontSize: 12, marginTop: 8 },
  cardSlot: { marginBottom: 18 },
  pageTitle: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "500",
    letterSpacing: -0.5,
    marginBottom: 18,
  },
  accountButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(255,210,122,0.28)",
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 11,
  },
  accountButtonText: { color: "#FFD27A", fontSize: 12, fontWeight: "600" },
  fab: {
    position: "absolute",
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#FFD27A",
    alignItems: "center",
    justifyContent: "center",
    elevation: 8,
    shadowColor: "#FFD27A",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
  },
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
  modalKicker: { color: "#9C8B5C", fontSize: 11, letterSpacing: 1.6, fontWeight: "600", textTransform: "uppercase" },
  modalTitle: { color: "#F5E6B8", fontSize: 20, fontWeight: "500", marginTop: 6 },
  modalMeta: { color: "#9C8B5C", fontSize: 12, marginTop: 4 },
  modalHint: { color: "#8F8F96", fontSize: 12, marginTop: 12, lineHeight: 18 },
  splitEntryButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 14, paddingVertical: 11, borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,210,122,0.28)", backgroundColor: "rgba(255,210,122,0.07)" },
  splitEntryText: { color: "#FFD27A", fontSize: 13, fontWeight: "600" },
  optionWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 18 },
  optionChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  optionChipPressed: { opacity: 0.6 },
  optionDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  optionLabel: { color: "#D8CDB0", fontSize: 12, fontWeight: "500" },
  inputLabel: {
    color: "#9C8B5C",
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginTop: 18,
    marginBottom: 8,
  },
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
  modalActions: { flexDirection: "row", gap: 8, marginTop: 18, justifyContent: "flex-end" },
  splitScroll: { maxHeight: 430, marginTop: 8 },
  splitRow: { paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(245,230,184,0.12)" },
  splitCategoryChoices: { gap: 7, paddingRight: 10, paddingBottom: 10 },
  splitCategorySelected: { backgroundColor: "rgba(255,210,122,0.18)", borderWidth: 2 },
  removeSplitText: { color: "#FF8E72", fontSize: 12, marginTop: 9, alignSelf: "flex-end" },
  addSplitButton: { paddingVertical: 13, alignItems: "center" },
  addSplitText: { color: "#FFD27A", fontSize: 13, fontWeight: "600" },
  splitBalance: { color: "#86D69C", fontSize: 13, fontWeight: "600", marginTop: 14 },
  splitBalancePending: { color: "#FFD27A" },
  splitError: { color: "#FF8E72", fontSize: 12, marginTop: 7 },
  cancelButton: { paddingVertical: 11, paddingHorizontal: 16, borderRadius: 11, borderWidth: 1, borderColor: "rgba(245,230,184,0.14)" },
  cancelButtonText: { color: "#D8CDB0", fontSize: 13, fontWeight: "600" },
  saveButton: { paddingVertical: 11, paddingHorizontal: 17, borderRadius: 11, backgroundColor: "#FFD27A" },
  saveButtonDisabled: { opacity: 0.4 },
  saveButtonText: { color: "#21160A", fontSize: 13, fontWeight: "700" },
  modalBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  modalBtnText: { color: "#D8CDB0", fontSize: 13, fontWeight: "500" },
  modalBtnPrimary: {
    backgroundColor: "#FFD27A",
    borderColor: "#FFD27A",
  },
  modalBtnTextPrimary: { color: "rgb(7,7,9)" },
  parentChipWrap: { flexDirection: "row", gap: 8, paddingRight: 8, marginTop: 4 },
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
