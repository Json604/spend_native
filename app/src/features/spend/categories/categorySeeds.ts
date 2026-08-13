import {
  SpendCategoryDefinition,
  SpendMerchantRule,
  SpendSourceKind,
  SpendSourceLabel,
} from "../types/types";

export const SPEND_SOURCE_LABELS: Record<SpendSourceKind, SpendSourceLabel> = {
  sms: "SMS",
  gmail: "Account",
  manual: "Manual",
};

// No preset spending categories — the user creates them in the Budget Planner.
// We only seed the two system buckets that the categorization pipeline relies
// on: "uncategorized" for non-debit/internal transfers and "needs-review" for
// any debit we couldn't auto-classify.
export const SPEND_CATEGORY_DEFINITIONS: SpendCategoryDefinition[] = [
  {
    id: "uncategorized",
    label: "Uncategorized",
    tint: "rgba(255, 255, 255, 0.72)",
    isSystem: true,
  },
  {
    id: "needs-review",
    label: "Needs Review",
    tint: "rgba(255, 208, 102, 0.9)",
    isSystem: true,
    isReviewCategory: true,
  },
];

// No preset merchant rules — every incoming SMS debit lands in "Needs review"
// until the user assigns a category.
export const SPEND_MERCHANT_RULES: SpendMerchantRule[] = [];
