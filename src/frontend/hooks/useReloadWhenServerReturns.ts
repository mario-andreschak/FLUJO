"use client";

import { useRef, useState } from 'react';
import { useTimeout } from './timing';

const FIRST_CHECK_MS = 5000;
const NEXT_CHECK_MS = 3000;

/**
 * While `restarting`, checks every few seconds whether the server answers and reloads the page
 * once it went down and came back up. An update stops, rebuilds and restarts the server, which
 * can take minutes.
 */
export function useReloadWhenServerReturns(restarting: boolean): void {
  const sawDown = useRef(false);
  const [checks, setChecks] = useState(0);
  useTimeout(() => {
    void fetch('/api/cwd', { cache: 'no-store' }).then((ping) => {
      if (ping.ok && sawDown.current) {
        window.location.reload();
        return;
      }
      setChecks((count) => count + 1);
    }, () => {
      sawDown.current = true;
      setChecks((count) => count + 1);
    });
  }, restarting ? (checks === 0 ? FIRST_CHECK_MS : NEXT_CHECK_MS) : null, checks);
}
