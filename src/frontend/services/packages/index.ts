/**
 * Frontend service for the package-creation wizard (issue #194).
 *
 * Thin fetch wrapper over the local-only `/api/packages/resolve` and
 * `/api/packages/build` routes, following the flowService singleton pattern
 * (list/preview reads swallow errors; build returns a structured result).
 */
import { createLogger } from '@/utils/logger';
import type {
  BuildManifestResult,
  PackageMetadataInput,
  PackageSelection,
  ResolvedSelection,
} from '@/backend/services/packages/buildPackage';
import type { PackageSecret } from '@/shared/types/package/secrets';
import type { SecretProposal } from '@/shared/types/package/secretProposal';
import type { InstallSummary } from '@/backend/services/packages/installPackage';

const log = createLogger('frontend/services/packages');

export interface DeriveSecretsResult {
  proposals: SecretProposal[];
  warnings: string[];
}

/** A pickable candidate value for the manual-secret picker (issue #285). */
export interface SecretValueCandidate {
  source: string;
  location: string;
  text: string;
}

export interface ResolveResult {
  resolved: ResolvedSelection;
  mcp: {
    ok: boolean;
    errors: string[];
    servers: Array<{ name: string; sourceType: string }>;
  };
  secrets: PackageSecret[];
}

class PackageService {
  /** Walk a selection to its full dependency closure + MCP validation preview. */
  async resolve(selection: PackageSelection): Promise<ResolveResult> {
    const response = await fetch('/api/packages/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selection),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return body as ResolveResult;
  }

  /**
   * Derive content-secret proposals for the "Secret review" step (issue #195).
   * The optional `modelIdentifier` enables the model-driven pass (which sends
   * packaged content to that provider).
   */
  async deriveSecrets(
    selection: PackageSelection,
    options: { modelIdentifier?: string; enableEntropy?: boolean; enableRepoSlug?: boolean } = {},
  ): Promise<DeriveSecretsResult> {
    const response = await fetch('/api/packages/derive-secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selection,
        modelIdentifier: options.modelIdentifier,
        enableEntropy: options.enableEntropy,
        enableRepoSlug: options.enableRepoSlug,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return body as DeriveSecretsResult;
  }

  /**
   * Enumerate pickable candidate values for the "Add a secret manually" value
   * picker (issue #285). Returns only plaintext already present in the packaged
   * content — never API keys or MCP env/header values.
   */
  async scanTargets(selection: PackageSelection): Promise<SecretValueCandidate[]> {
    const response = await fetch('/api/packages/scan-targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return (body?.candidates ?? []) as SecretValueCandidate[];
  }

  /**
   * Install a package from the online registry (issue #198). Two-phase: call
   * with `consentGranted: false` (or omitted) first for a dry-run preview of
   * the manifest contents + required secrets, then again with
   * `consentGranted: true` and the collected secret values to actually install.
   */
  async installFromRegistry(input: {
    packageId: string;
    version?: string;
    secrets?: Record<string, string>;
    consentGranted?: boolean;
  }): Promise<InstallSummary> {
    const response = await fetch('/api/packages/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'registry', ...input }),
    });
    const body = await response.json();
    if (!response.ok && body?.ok === undefined) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return body as InstallSummary;
  }

  /** Build the package manifest; returns the structured build result. */
  async build(
    selection: PackageSelection,
    metadata: PackageMetadataInput,
    acceptedSecrets: SecretProposal[] = [],
  ): Promise<BuildManifestResult> {
    const response = await fetch('/api/packages/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection, metadata, acceptedSecrets }),
    });
    const body = await response.json();
    if (!response.ok && body?.ok === undefined) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return body as BuildManifestResult;
  }
}

let _packageService: PackageService | null = null;

export const getPackageService = (): PackageService => {
  if (typeof window === 'undefined') {
    throw new Error('PackageService can only be used in browser environment');
  }
  if (!_packageService) {
    _packageService = new PackageService();
  }
  return _packageService;
};

// Lazy proxy so importing this module never throws during SSR/prerender.
export const packageService: PackageService = new Proxy({} as PackageService, {
  get(_target, prop) {
    const service = getPackageService();
    const value = (service as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(service) : value;
  },
});

export type { PackageSelection, PackageMetadataInput, BuildManifestResult, ResolvedSelection, InstallSummary };
