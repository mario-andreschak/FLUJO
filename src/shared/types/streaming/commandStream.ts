/**
 * Shared event contract for live-streamed server-side command output (issues #64, #65).
 *
 * A single small envelope is reused by every FLUJO feature that needs to forward the
 * stdout/stderr and lifecycle of a server-side operation to the browser console as it
 * happens, rather than buffering it into one final blob:
 *   - #64 — the MCP "Test Run" handshake probe (stderr + lifecycle markers).
 *   - #65 — the Install / Build command runners (live stdout + stderr).
 *
 * The events are framed as NDJSON on the wire (one JSON object per line). See
 * `@/shared/utils/ndjson` for the (pure, testable) encode/parse helpers, the backend
 * `@/backend/utils/ndjsonStream` Response builder, and the frontend
 * `@/frontend/utils/ndjsonReader` consumer.
 */

/** Lifecycle phase markers, emitted so the console can show friendly progress lines. */
export type CommandStreamPhase =
  | 'spawning'
  | 'handshaking'
  | 'listing-tools'
  | 'running';

export interface CommandStreamStatusEvent {
  type: 'status';
  phase: CommandStreamPhase;
  message?: string;
}

export interface CommandStreamStdoutEvent {
  type: 'stdout';
  data: string;
}

export interface CommandStreamStderrEvent {
  type: 'stderr';
  data: string;
}

/**
 * Terminal event. Mirrors the object the corresponding non-streaming route/service
 * would have returned, so the streaming and non-streaming paths converge on one shape.
 * `data`/`requiresAuthentication` are used by the Test Run probe (#64); `commandOutput`
 * is used by the Install/Build runners (#65).
 */
export interface CommandStreamResultEvent {
  type: 'result';
  success: boolean;
  error?: string;
  requiresAuthentication?: boolean;
  /** Test Run only: the server advertises OAuth (RFC 9728). Lets the modal offer a
   * "Save & Authenticate" action instead of only hinting at a static header. */
  oauthCapable?: boolean;
  data?: { toolCount?: number };
  commandOutput?: string;
}

export type CommandStreamEvent =
  | CommandStreamStatusEvent
  | CommandStreamStdoutEvent
  | CommandStreamStderrEvent
  | CommandStreamResultEvent;

/**
 * Alias used by the MCP Test Run probe (#64). Test Run only ever emits `stderr`
 * + lifecycle `status` markers + a final `result` (its `data.toolCount` /
 * `requiresAuthentication` fields), but it shares the same envelope so the
 * Install/Build feature (#65) can reuse the exact same plumbing.
 */
export type TestConnectionEvent = CommandStreamEvent;
