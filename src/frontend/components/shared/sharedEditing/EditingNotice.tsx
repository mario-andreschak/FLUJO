"use client";

import React from 'react';
import { Alert } from '@mui/material';
import type { OtherEditor } from '@/frontend/services/sharedItems';

function names(others: readonly OtherEditor[]): string {
  const list = others.map(other => other.name);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * "Anna is editing this too" (#575). Shown only while multi-user mode is on
 * and someone else has the same flow, model or MCP server open. It informs;
 * it never blocks a save.
 */
export default function EditingNotice({ others }: { others: readonly OtherEditor[] }) {
  if (others.length === 0) return null;
  const verb = others.length === 1 ? 'is' : 'are';
  return (
    <Alert severity="info" role="status" data-testid="editing-notice">
      {names(others)} {verb} editing this too. If they save first, you will be asked what to keep.
    </Alert>
  );
}
