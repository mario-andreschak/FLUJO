export const NATIVE_HANDOFF_PROTOCOL = 'owned-claude-exit-close-v1' as const;
export const CODEX_HANDOFF_PROTOCOL = 'owned-codex-app-server-exit-close-v1' as const;
export type NativeHandoffProtocol = typeof NATIVE_HANDOFF_PROTOCOL | typeof CODEX_HANDOFF_PROTOCOL;
export const isNativeHandoffProtocol = (value:unknown):value is NativeHandoffProtocol =>
  value===NATIVE_HANDOFF_PROTOCOL || value===CODEX_HANDOFF_PROTOCOL;
