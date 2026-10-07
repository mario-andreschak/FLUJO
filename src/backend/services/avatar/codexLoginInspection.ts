import { readCodexAuthForTransfer } from '@/backend/services/model/adapters/codexAuth';

type LoginInspection = {
  authentication: 'login-detected' | 'needs-connection' | 'incompatible' | 'unknown';
  reasonCode?: string;
};

// Project only the existing 3.46.2 adapter's fixed diagnostics. Its execution,
// credential source, transfer and refresh behavior remain unchanged.
const diagnostics = new Map<string, LoginInspection>([
  ['Could not verify the host Codex credential store. Repair or make its config.toml readable before using its login in FLUJO.', { authentication: 'unknown', reasonCode: 'credential-store-unreadable' }],
  ['FLUJO requires file-backed Codex authentication. Configure cli_auth_credentials_store = "file" and sign in again; keyring and auto storage cannot identify the active login from auth.json.', { authentication: 'incompatible', reasonCode: 'credential-store-incompatible' }],
  ['Could not read FLUJO Codex authentication source.', { authentication: 'unknown', reasonCode: 'auth-source-unreadable' }],
  ['A file-backed Codex ChatGPT login is required. Sign in with Codex using file credential storage before cloning.', { authentication: 'needs-connection', reasonCode: 'login-missing' }],
  ['The Codex authentication cache is not a transferable ChatGPT login.', { authentication: 'incompatible', reasonCode: 'login-incompatible' }],
]);

/** Read-only discovery; never prepares a runtime, copies or returns credentials. */
export async function inspectCodexLogin(workspace?: string): Promise<LoginInspection> {
  try {
    await readCodexAuthForTransfer(workspace);
    return { authentication: 'login-detected' };
  } catch (error) {
    const known = error instanceof Error ? diagnostics.get(error.message) : undefined;
    return known ? { ...known } : { authentication: 'unknown', reasonCode: 'inspection-unavailable' };
  }
}
