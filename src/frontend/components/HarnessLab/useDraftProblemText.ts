'use client';

import { useCallback } from 'react';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { MAX_COMPARISON_CASES, MAX_COMPARISON_VARIANTS } from '@/shared/types/harnessComparison';
import type { DraftProblem } from './comparisonDraft';

export type AnyDraftProblem = DraftProblem | { code: 'syntax' | 'notAList'; message?: string };

/** One place that words what stops a comparison from starting. */
export function useDraftProblemText() {
  const { t } = useI18n();
  return useCallback((problem: AnyDraftProblem): string => {
    switch (problem.code) {
      case 'name': return t('harness.compare.problemName');
      case 'noVariant': return t('harness.compare.problemNoVariant');
      case 'tooManyVariants': return t('harness.compare.problemTooManyVariants', { max: MAX_COMPARISON_VARIANTS });
      case 'variantFlow': return t('harness.compare.problemVariantFlow', { number: problem.variant });
      case 'noExamples': return t('harness.compare.problemNoExamples');
      case 'tooManyExamples': return t('harness.compare.problemTooManyExamples', { max: MAX_COMPARISON_CASES });
      case 'duplicateId': return t('harness.compare.problemDuplicateId', { id: problem.id });
      case 'example': return t('harness.compare.problemExample', { number: problem.example, problem: problem.message });
      case 'syntax': return t('harness.compare.problemSyntax', { problem: problem.message ?? '' });
      case 'notAList': return t('harness.compare.problemNotList');
      case 'other': return problem.message;
    }
  }, [t]);
}
