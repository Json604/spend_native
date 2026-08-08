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
import { selectDailyBuckets } from "../store/selectors";
import SpendTodayHeroCard from "../components/SpendTodayHeroCard";
import SpendBudgetCard from "../components/SpendBudgetCard";
import SpendDayTransactionsCard from "../components/SpendDayTransactionsCard";
import SpendCategoryCard from "../components/SpendCategoryCard";
import SpendDailyBarsCard from "../components/SpendDailyBarsCard";
import SpendNeedsReviewCard from "../components/SpendNeedsReviewCard";

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
    actions,
  } = useSpend();

  const [refreshing, setRefreshing] = useState(false);
  const [reviewModalVisible, setReviewModalVisible] = useState(false);
  const [selectedReviewTransactionId, setSelectedReviewTransactionId] = useState<string | null>(null);
  const [customCategory, setCustomCategory] = useState("");
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [selectedBucketDate, setSelectedBucketDate] = useState<string | null>(null);
  const [reviewCustomParentId, setReviewCustomParentId] = useState<string | null>(null);

  const reviewRootOptions = useMemo(
    () =>
      categoryOptions
        .filter((opt) => !opt.parentId)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [categoryOptions],
  );

  const dailyBuckets = useMemo(() => selectDailyBuckets(domain.state), [domain.state]);

  const activeBucket = useMemo(() => {
    if (selectedBucketDate) {
      return dailyBuckets.find((b) => b.date === selectedBucketDate) ?? null;
    }
    return dailyBuckets.find((b) => b.isToday) ?? null;
  }, [dailyBuckets, selectedBucketDate]);

  const dayTransactions = useMemo(() => {
    if (!activeBucket) return [];
    const ref = new Date(activeBucket.date);
    return domain.state.transactions
      .filter((t) => {
        if (t.direction !== "debit" || t.status === "ignored") return false;
        const d = new Date(t.occurredAt);
        return (
          d.getFullYear() === ref.getFullYear() &&
          d.getMonth() === ref.getMonth() &&
          d.getDate() === ref.getDate()
        );
      })
      .sort(
        (a, b) =>
          new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
      );
  }, [domain.state, activeBucket]);

  const monthName = useMemo(
    () => new Date().toLocaleString(undefined, { month: "long" }),
    [],
  );

  // Deep-link routing
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      if (url.startsWith("lym://spend/add")) {
        navigation.navigate("SpendManualEntry");
      } else if (url.startsWith("lym://spend/budget")) {
        navigation.navigate("SpendBudgetPlanner");
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
        <Text style={styles.pageTitle}>Spend</Text>

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
            onDeleteTransaction={(id) => actions.deleteTransaction(id)}
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
            />
          </View>
        ) : null}
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

            <View style={styles.optionWrap}>
              {categoryOptions.map((option) => (
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
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#070709" },
  content: { paddingHorizontal: 18 },
  cardSlot: { marginBottom: 18 },
  pageTitle: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "500",
    letterSpacing: -0.5,
    marginBottom: 18,
  },
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
