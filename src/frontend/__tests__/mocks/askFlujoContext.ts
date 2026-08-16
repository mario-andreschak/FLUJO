/**
 * Reusable jest mock for `@/frontend/contexts/AskFlujoContext`.
 *
 * Any component rendered under test that calls `useAskFlujo()` /
 * `useAskFlujoPage()` — directly, or transitively via `AskFlujoButton`,
 * `BugReportButton`'s sibling, or `DialogHeaderActions` — needs the real
 * `AskFlujoProvider` in the tree or this mock, otherwise `useAskFlujo` throws
 * ("must be used inside AskFlujoProvider").
 *
 * NOTE: `jest.mock(...)` factories are hoisted above imports by
 * `babel-plugin-jest-hoist`, which only allows the factory to reference
 * out-of-scope identifiers whose name starts with `mock` (case-insensitive).
 * That's why the exports below are named `mock...` rather than
 * `createAskFlujo...` — import them directly into the factory:
 *
 * ```ts
 * import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
 *
 * jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
 *   useAskFlujo: mockUseAskFlujo,
 *   useAskFlujoPage: mockUseAskFlujoPage,
 * }));
 * ```
 *
 * `mockUseAskFlujo` returns a fresh value object (with fresh `jest.fn()`s)
 * on every call, so `jest.fn()` call counts never leak between tests/renders.
 */

export function mockUseAskFlujo() {
  return {
    open: false,
    openDock: jest.fn(),
    closeDock: jest.fn(),
    toggleDock: jest.fn(),
    getPageContext: jest.fn(),
    applyPageAction: jest.fn(),
    registerPage: jest.fn(() => jest.fn()),
  };
}

export const mockUseAskFlujoPage = jest.fn();
