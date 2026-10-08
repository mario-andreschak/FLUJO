export const NATIVE_HANDOFF_PROTOCOL = 'owned-claude-exit-close-v1' as const;
export const CODEX_NATIVE_HANDOFF_PROTOCOL = 'owned-codex-app-server-exit-close-v1' as const;
export type NativeHandoffProtocol = typeof NATIVE_HANDOFF_PROTOCOL | typeof CODEX_NATIVE_HANDOFF_PROTOCOL;
export function isNativeHandoffProtocol(value: unknown): value is NativeHandoffProtocol {
  return value === NATIVE_HANDOFF_PROTOCOL || value === CODEX_NATIVE_HANDOFF_PROTOCOL;
}
