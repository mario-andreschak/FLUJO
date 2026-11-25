"use client";

import { useEffect, useState } from 'react';
import { useInterval } from './timing';
import {
  clearEditBase, isMultiUserMode, releaseEditLease, setEditBase, takeEditLease,
  type OtherEditor, type SharedItemKind,
} from '@/frontend/services/sharedItems';

export interface EditLeaseView {
  /** True while multi-user mode is on and this editor holds a lease. */
  readonly enabled: boolean;
  /** Other people with the same item open right now. */
  readonly others: readonly OtherEditor[];
  /** The item's version when the editor opened. */
  readonly revision: string | null;
}

const OFF: EditLeaseView = Object.freeze({ enabled: false, others: [], revision: null });

interface HeldLease extends EditLeaseView {
  readonly key: string;
  readonly renewInMs: number;
}

/**
 * Keep an "I am editing this" lease while an editor is open (#575). Opens on
 * mount, renews every 20 seconds, and lets go when the editor closes or the
 * page unloads. A closed laptop simply stops renewing; the server forgets the
 * lease after a minute.
 *
 * With multi-user mode off it only asks the (cached) mode once and nothing
 * else: no lease request is made and it returns `enabled: false`.
 *
 * `registerBase` (default for models and MCP servers) remembers the version
 * the editor opened, so its save can say which version it started from.
 * Flows carry their own version (`updatedAt`), so the flow builder registers
 * that instead.
 */
export function useEditLease(kind: SharedItemKind, id: string | null | undefined, active: boolean,
  options: { registerBase?: boolean } = {}): EditLeaseView {
  const registerBase = options.registerBase ?? kind !== 'flow';
  const target = active && id ? id : null;
  const key = target ? `${kind}\u0000${target}` : null;
  const [held, setHeld] = useState<HeldLease | null>(null);

  useEffect(() => {
    if (!target || !key) return undefined;
    const controller = new AbortController();
    let opened = false;
    void isMultiUserMode().then(async on => {
      if (!on || controller.signal.aborted) return;
      const answer = await takeEditLease(kind, target, controller.signal);
      if (controller.signal.aborted || !answer?.enabled) return;
      opened = true;
      if (registerBase && answer.revision) setEditBase(kind, target, answer.revision);
      setHeld({ key, enabled: true, others: answer.others, revision: answer.revision, renewInMs: answer.renewInMs });
    });
    const onPageHide = () => {
      if (opened) releaseEditLease(kind, target);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      controller.abort();
      window.removeEventListener('pagehide', onPageHide);
      if (opened) releaseEditLease(kind, target);
      if (registerBase) clearEditBase(kind, target);
    };
  }, [kind, target, key, registerBase]);

  const current = held && held.key === key ? held : null;

  useInterval(() => {
    if (!current || !target) return;
    void takeEditLease(kind, target).then(answer => {
      if (!answer?.enabled) return;
      setHeld(previous => previous && previous.key === current.key ? { ...previous, others: answer.others } : previous);
    });
  }, current ? current.renewInMs : null);

  return current ? { enabled: true, others: current.others, revision: current.revision } : OFF;
}
