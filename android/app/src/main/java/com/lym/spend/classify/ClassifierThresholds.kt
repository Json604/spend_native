package com.lym.spend.classify

/**
 * Provisional defaults, deliberately conservative. They must be evaluated
 * against the migrated corpus before silent auto-apply is enabled broadly.
 */
object ClassifierThresholds {
  /** The classifier owns the confidence bands consumed by notification UX. */
  const val NOTIFICATION_MID_CONFIDENCE = 0.60
  const val NOTIFICATION_SUGGESTION_LIMIT = 3

  const val MEMORY_MIN_OBSERVATIONS = 5
  const val MEMORY_DOMINANCE_RATIO = 0.90
  const val MEMORY_AUTO_APPLY_CONFIDENCE = 0.90
  const val MEMORY_OBSERVATION_PRIOR = 3.0
  const val MEMORY_PROVISIONAL_CONFIDENCE_CAP = 0.59

  const val RULE_AUTO_APPLY_CONFIDENCE = 0.90

  const val SIMILARITY_MIN_SUPPORT = 3
  const val SIMILARITY_MIN_TOKEN_OVERLAP = 0.50
  const val SIMILARITY_DOMINANCE_RATIO = 0.80
  const val SIMILARITY_AUTO_APPLY_CONFIDENCE = 0.90
  const val SIMILARITY_SUPPORT_PRIOR = 2.0
  const val SIMILARITY_TOKEN_WEIGHT = 0.75
  const val SIMILARITY_AMOUNT_WEIGHT = 0.25
}
