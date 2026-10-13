/**
 * Persisted conversation-list sidecar version, shared by its writer and recovery.
 * Version 10 derives automation sidebar titles from output instead of the trigger
 * prompt; older indexes are rebuilt by the reader and remain valid recovery data.
 */
export const CONVERSATION_SUMMARY_VERSION = 10;
