/**
 * Re-import an exported package manifest back into the creation wizard.
 *
 * Exporting is lossy in exactly one direction: secret VALUES are redacted (by
 * design). Everything the wizard needs to reconstruct a run is still in the
 * manifest — the packaged flows/models/servers/planned executions carry their
 * original host ids/names, and the metadata step's fields are top-level. So a
 * manifest can restore the selection, the metadata and WHICH secrets were
 * accepted (by name), which is what makes iterating on a package practical:
 * export → tweak → re-import instead of re-walking every step by hand.
 *
 * Pure/isomorphic like the rest of `src/shared/types/package/` — the wizard
 * imports this directly in the browser.
 */
import type { FlujoPackage } from './package';
import { validatePackage } from './package.serialize';

/** The entity ids/names that currently exist on this host. */
export interface AvailableEntities {
  flowIds: readonly string[];
  modelIds: readonly string[];
  mcpServerNames: readonly string[];
  plannedExecutionIds: readonly string[];
}

/** A wizard selection restored from a manifest. */
export interface ImportedSelection {
  flowIds: string[];
  modelIds: string[];
  mcpServerNames: string[];
  plannedExecutionIds: string[];
}

/** Metadata-step values restored from a manifest. */
export interface ImportedMetadata {
  name: string;
  version: string;
  description: string;
  tags: string[];
}

export interface WizardDraft {
  selection: ImportedSelection;
  metadata: ImportedMetadata;
  /**
   * Names of every secret the manifest declared. The wizard re-runs the content
   * scan against live entities and auto-accepts the rows whose suggested name
   * appears here, reproducing the previous export's redaction choices.
   */
  secretNames: string[];
  /** Entities the manifest referenced that no longer exist on this host. */
  missing: Array<{ type: 'flow' | 'model' | 'mcpServer' | 'plannedExecution'; label: string }>;
}

/**
 * Map a validated manifest to a wizard draft, keeping only entities that still
 * exist locally (the wizard can only select live entities). Anything gone is
 * reported in `missing` so the user learns why the selection shrank instead of
 * silently exporting less than last time.
 */
export function packageToWizardDraft(pkg: FlujoPackage, available: AvailableEntities): WizardDraft {
  const liveFlows = new Set(available.flowIds);
  const liveModels = new Set(available.modelIds);
  const liveServers = new Set(available.mcpServerNames);
  const livePlanned = new Set(available.plannedExecutionIds);

  const missing: WizardDraft['missing'] = [];
  const selection: ImportedSelection = {
    flowIds: [],
    modelIds: [],
    mcpServerNames: [],
    plannedExecutionIds: [],
  };

  for (const entry of pkg.flows ?? []) {
    const id = entry?.flow?.id;
    if (!id) continue;
    if (liveFlows.has(id)) selection.flowIds.push(id);
    else missing.push({ type: 'flow', label: entry.flow?.name ? `${entry.flow.name} (${id})` : id });
  }
  for (const model of pkg.models ?? []) {
    if (!model?.id) continue;
    if (liveModels.has(model.id)) selection.modelIds.push(model.id);
    else missing.push({ type: 'model', label: model.displayName || model.name || model.id });
  }
  for (const server of pkg.mcpServers ?? []) {
    if (!server?.name) continue;
    if (liveServers.has(server.name)) selection.mcpServerNames.push(server.name);
    else missing.push({ type: 'mcpServer', label: server.name });
  }
  for (const pe of pkg.plannedExecutions ?? []) {
    const id = (pe as { id?: string })?.id;
    if (!id) continue;
    if (livePlanned.has(id)) selection.plannedExecutionIds.push(id);
    else missing.push({ type: 'plannedExecution', label: (pe as { name?: string }).name || id });
  }

  return {
    selection,
    metadata: {
      name: pkg.name ?? '',
      version: pkg.version ?? '',
      description: pkg.description ?? '',
      tags: pkg.tags ? [...pkg.tags] : [],
    },
    secretNames: (pkg.secrets ?? []).map((s) => s.name).filter(Boolean),
    missing,
  };
}

export type ParseImportedPackageResult =
  | { ok: true; package: FlujoPackage }
  | { ok: false; errors: string[] };

/**
 * Parse + validate an uploaded manifest file's text. Never throws: bad JSON and
 * schema violations both come back as human-readable errors for the wizard to
 * render.
 */
export function parseImportedPackage(text: string): ParseImportedPackageResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const result = validatePackage(raw);
  if (!result.success || !result.data) {
    return { ok: false, errors: result.errors ?? ['Not a valid FLUJO package manifest'] };
  }
  return { ok: true, package: result.data };
}
