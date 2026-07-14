/**
 * SEP-1024 install-consent IO layer (issue #98).
 *
 * The pure policy (settings shape, consent decision, audit-entry builder) lives
 * in `@/utils/mcp/autoInstallConsent`; this module is only its backend IO:
 *   - load/save the `mcpAutoInstall` settings blob through the storage chokepoint,
 *   - append install decisions to a bounded audit log (db/mcp-install-audit.json),
 *     a ring buffer of the newest records, using the same read-modify-write chain
 *     idiom as the scheduler's run history.
 *
 * The audit log is the SEP-1024 accountability guarantee: on EVERY install path
 * (trusted or not, resolve-only or actually installed), a record of the exact
 * command + args + required env NAMES + verification status is written BEFORE any
 * spawn. It never contains secret values.
 */
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import {
  McpAutoInstallSettings,
  DEFAULT_MCP_AUTO_INSTALL_SETTINGS,
  normalizeAutoInstallSettings,
  InstallAuditEntry,
} from '@/utils/mcp/autoInstallConsent';

const log = createLogger('backend/services/mcp/autoInstall');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadAutoInstallSettings(): Promise<McpAutoInstallSettings> {
  try {
    const raw = await loadItem<Partial<McpAutoInstallSettings>>(
      StorageKey.MCP_AUTO_INSTALL_SETTINGS,
      DEFAULT_MCP_AUTO_INSTALL_SETTINGS
    );
    return normalizeAutoInstallSettings(raw);
  } catch (error) {
    // A missing/corrupt settings file must fall back to the SAFE defaults
    // (require consent) rather than fail-open.
    log.warn('Failed to load mcpAutoInstall settings; using safe defaults', error);
    return { ...DEFAULT_MCP_AUTO_INSTALL_SETTINGS };
  }
}

export async function saveAutoInstallSettings(settings: McpAutoInstallSettings): Promise<void> {
  await saveItem(StorageKey.MCP_AUTO_INSTALL_SETTINGS, normalizeAutoInstallSettings(settings));
}

// ---------------------------------------------------------------------------
// Audit log (bounded ring buffer, oldest first)
// ---------------------------------------------------------------------------

const AUDIT_KEY = 'mcp-install-audit' as StorageKey;
const MAX_AUDIT_RECORDS = 300;

// Append is a read-modify-write, so serialize appends behind a single chain
// (saveItem already serializes same-key WRITES, but not the read+write pair).
let appendChain: Promise<unknown> = Promise.resolve();

export async function loadInstallAudit(): Promise<InstallAuditEntry[]> {
  try {
    return await loadItem<InstallAuditEntry[]>(AUDIT_KEY, []);
  } catch (error) {
    log.error('Failed to load MCP install audit log', error);
    return [];
  }
}

/**
 * Append an audit entry. Best-effort by design: a failure to persist the audit
 * log is logged loudly but never thrown, so it cannot itself block/break an
 * install decision (the caller has already decided; the record is accountability).
 */
export async function appendInstallAudit(entry: InstallAuditEntry): Promise<void> {
  const run = appendChain
    .catch(() => { /* prior append's error already logged */ })
    .then(async () => {
      const records = await loadInstallAudit();
      records.push(entry);
      const trimmed = records.slice(-MAX_AUDIT_RECORDS);
      await saveItem(AUDIT_KEY, trimmed);
    })
    .catch((error) => {
      log.error('Failed to append MCP install audit entry', error);
    });
  appendChain = run;
  await run;
}
