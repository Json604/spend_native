import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import SpendSurface from "./SpendSurface";
import { SpendReviewItem, SpendReviewPreview } from "../types/types";

type SpendNeedsReviewCardProps = {
  reviewPreview: SpendReviewPreview;
  reviewItems: SpendReviewItem[];
  pendingCount: number;
  onSelectReview?: (transactionId: string) => void;
  onIgnoreReview?: (transactionId: string) => void;
};

export default function SpendNeedsReviewCard({
  reviewPreview,
  reviewItems,
  pendingCount,
  onSelectReview,
  onIgnoreReview,
}: SpendNeedsReviewCardProps) {
  return (
    <SpendSurface>
      <View style={styles.row}>
        <View style={styles.iconShell}>
          <MaterialCommunityIcons name="account-question-outline" size={18} color="white" />
        </View>
        <View style={styles.textWrap}>
          <Text style={styles.title}>Needs review</Text>
          <Text style={styles.subtitle}>
            Unclear person-to-person transfers will ask you for a category once, then learn it.
          </Text>
        </View>
      </View>

      {reviewItems.length ? (
        <ScrollView
          style={styles.scrollWrap}
          contentContainerStyle={styles.scrollContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
        >
          {reviewItems.map((item, index) => (
            <View
              key={item.transactionId}
              style={[
                styles.prompt,
                index === 0 && reviewPreview.transactionId === item.transactionId
                  ? styles.promptEnabled
                  : null,
              ]}
            >
              <Text style={styles.promptLabel}>Pending payee</Text>
              <Text style={styles.payee}>{item.payee}</Text>
              <Text style={styles.amount}>
                {item.amountLabel} · {item.occurredAtLabel}
              </Text>
              <Text style={styles.promptHint} numberOfLines={2}>
                {item.description}
              </Text>
              <View style={styles.actionRow}>
                <Pressable
                  onPress={() => onIgnoreReview?.(item.transactionId)}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>{"Don't add"}</Text>
                </Pressable>
                <Pressable
                  onPress={() => onSelectReview?.(item.transactionId)}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>Choose category</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.prompt}>
          <Text style={styles.promptLabel}>Example payee</Text>
          <Text style={styles.payee}>{reviewPreview.payee}</Text>
          {reviewPreview.amountLabel ? (
            <Text style={styles.amount}>{reviewPreview.amountLabel}</Text>
          ) : null}
          <Text style={styles.promptHint}>{reviewPreview.hint}</Text>
        </View>
      )}

      <Text style={styles.reviewCount}>
        {pendingCount > 0
          ? `${pendingCount} pending review${pendingCount === 1 ? "" : "s"}`
          : "No pending reviews"}
      </Text>
    </SpendSurface>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  iconShell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255, 215, 0, 0.16)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.22)",
  },
  textWrap: {
    flex: 1,
    gap: 6,
  },
  title: {
    color: "white",
    fontSize: 20,
    fontWeight: "600",
  },
  subtitle: {
    color: "rgba(255, 255, 255, 0.60)",
    fontSize: 13,
    lineHeight: 20,
  },
  scrollWrap: {
    maxHeight: 320,
    marginTop: 18,
  },
  scrollContent: {
    gap: 12,
    paddingBottom: 2,
  },
  prompt: {
    padding: 16,
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.07)",
  },
  promptEnabled: {
    borderColor: "rgba(255, 215, 0, 0.16)",
  },
  promptLabel: {
    color: "rgba(255, 255, 255, 0.50)",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  payee: {
    color: "white",
    fontSize: 17,
    fontWeight: "600",
    marginTop: 6,
  },
  amount: {
    color: "rgba(255, 215, 0, 0.90)",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 8,
  },
  promptHint: {
    color: "rgba(255, 255, 255, 0.60)",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.10)",
  },
  primaryButton: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: "rgba(255, 215, 0, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.24)",
  },
  buttonPressed: {
    opacity: 0.86,
    transform: [{ scale: 0.99 }],
  },
  secondaryButtonText: {
    color: "rgba(255, 255, 255, 0.82)",
    fontSize: 13,
    fontWeight: "600",
  },
  primaryButtonText: {
    color: "rgba(255, 232, 170, 0.96)",
    fontSize: 13,
    fontWeight: "600",
  },
  reviewCount: {
    color: "rgba(255, 255, 255, 0.44)",
    fontSize: 12,
    marginTop: 12,
  },
});
