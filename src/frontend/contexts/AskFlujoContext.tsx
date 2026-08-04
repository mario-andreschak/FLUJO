"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePathname } from 'next/navigation';
import type {
  AskFlujoActionHandler,
  AskFlujoActionResult,
  AskFlujoPageContext,
  AskFlujoUiAction,
} from '@/frontend/types/askFlujo';

interface PageRegistration {
  id: symbol;
  priority: number;
  sequence: number;
  getContext: () => AskFlujoPageContext;
  handleAction?: AskFlujoActionHandler;
}

interface AskFlujoContextValue {
  open: boolean;
  openDock: () => void;
  closeDock: () => void;
  toggleDock: () => void;
  getPageContext: () => AskFlujoPageContext;
  applyPageAction: (action: AskFlujoUiAction) => Promise<AskFlujoActionResult>;
  registerPage: (
    id: symbol,
    getContext: () => AskFlujoPageContext,
    handleAction: AskFlujoActionHandler | undefined,
    priority: number,
  ) => () => void;
}

const AskFlujoContext = createContext<AskFlujoContextValue | null>(null);

export function AskFlujoProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const registrations = useRef(new Map<symbol, PageRegistration>());
  const sequence = useRef(0);

  const registerPage = useCallback<AskFlujoContextValue['registerPage']>((id, getContext, handleAction, priority) => {
    sequence.current += 1;
    registrations.current.set(id, {
      id,
      getContext,
      handleAction,
      priority,
      sequence: sequence.current,
    });
    return () => {
      registrations.current.delete(id);
    };
  }, []);

  const activeRegistration = useCallback((): PageRegistration | undefined => {
    return [...registrations.current.values()].sort(
      (left, right) => right.priority - left.priority || right.sequence - left.sequence,
    )[0];
  }, []);

  const getPageContext = useCallback((): AskFlujoPageContext => {
    const registered = activeRegistration();
    if (registered) return registered.getContext();
    const main = typeof document === 'undefined' ? null : document.getElementById('main-content');
    const visibleText = main?.innerText?.trim().slice(0, 20_000) ?? '';
    return {
      scopeId: `route:${pathname}`,
      pageType: 'generic',
      route: pathname,
      title: typeof document === 'undefined' ? 'FLUJO' : document.title,
      data: {
        visibleText,
        headings: typeof document === 'undefined'
          ? []
          : [...document.querySelectorAll('main h1, main h2, main h3')]
            .map(element => element.textContent?.trim())
            .filter(Boolean)
            .slice(0, 50),
      },
      capabilities: {
        notes: ['Generic page context includes the visible main-page text. Input values are intentionally excluded.'],
      },
    };
  }, [activeRegistration, pathname]);

  const applyPageAction = useCallback(async (action: AskFlujoUiAction): Promise<AskFlujoActionResult> => {
    const handler = activeRegistration()?.handleAction;
    if (!handler) {
      return { success: false, message: 'This page does not expose that UI action.' };
    }
    try {
      return await handler(action);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'The UI action failed.',
      };
    }
  }, [activeRegistration]);

  const value = useMemo<AskFlujoContextValue>(() => ({
    open,
    openDock: () => setOpen(true),
    closeDock: () => setOpen(false),
    toggleDock: () => setOpen(current => !current),
    getPageContext,
    applyPageAction,
    registerPage,
  }), [open, getPageContext, applyPageAction, registerPage]);

  return <AskFlujoContext.Provider value={value}>{children}</AskFlujoContext.Provider>;
}

export function useAskFlujo() {
  const value = useContext(AskFlujoContext);
  if (!value) throw new Error('useAskFlujo must be used inside AskFlujoProvider.');
  return value;
}

/**
 * Register live page state without copying it into provider state. The refs are
 * read only when the dock sends a turn, so unsaved edits are always current and
 * rapid page renders do not create a provider update loop.
 */
export function useAskFlujoPage(
  context: AskFlujoPageContext,
  handleAction?: AskFlujoActionHandler,
  priority = 0,
) {
  const { registerPage } = useAskFlujo();
  const id = useRef(Symbol('ask-flujo-page'));
  const contextRef = useRef(context);
  const handlerRef = useRef(handleAction);
  contextRef.current = context;
  handlerRef.current = handleAction;

  useEffect(() => registerPage(
    id.current,
    () => contextRef.current,
    action => handlerRef.current
      ? handlerRef.current(action)
      : { success: false, message: 'This page is read-only for Ask FLUJO.' },
    priority,
  ), [priority, registerPage]);
}
