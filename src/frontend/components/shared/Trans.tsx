"use client";

import { Fragment, type ReactNode } from 'react';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';

interface TransProps {
  message: TranslationKey;
  /** React nodes may be used for links or emphasis embedded in a sentence. */
  values?: Record<string, ReactNode>;
}

/**
 * Render a translated message with named rich placeholders. A catalog message
 * such as "Open {settingsLink} to continue" can safely receive a real Link
 * component without splitting the sentence into context-free fragments.
 */
export default function Trans({ message, values = {} }: TransProps) {
  const { t } = useI18n();
  const placeholders = Object.fromEntries(
    Object.keys(values).map((name) => [name, `{${name}}`]),
  );
  const translated = t(message, placeholders);
  const parts = translated.split(/(\{[a-zA-Z0-9_]+\})/g);

  return parts.map((part, index) => {
    const match = /^\{([a-zA-Z0-9_]+)\}$/.exec(part);
    if (!match) return <Fragment key={index}>{part}</Fragment>;
    return <Fragment key={`${match[1]}-${index}`}>{values[match[1]] ?? part}</Fragment>;
  });
}
