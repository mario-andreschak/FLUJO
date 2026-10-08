/** Shared package build DTOs. Types only; backend operations remain with their services. */
import type { FlujoPackage } from './package';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** What the user ticked in the wizard's "Select contents" step. */
export interface PackageSelection {
  flowIds?: string[];
  modelIds?: string[];
  mcpServerNames?: string[];
  plannedExecutionIds?: string[];
}

export type PackageEntityType = 'flow' | 'model' | 'mcpServer' | 'plannedExecution';

export interface AutoAddedRef {
  type: PackageEntityType;
  id: string;
  /** Human-readable reason the item was pulled in automatically. */
  reason: string;
}

/** Result of walking a selection to its full dependency closure. */
export interface ResolvedSelection {
  flowIds: string[];
  modelIds: string[];
  mcpServerNames: string[];
  plannedExecutionIds: string[];
  autoAdded: AutoAddedRef[];
  /** Non-fatal advisories (missing referenced entity, circular subflow, …). */
  warnings: string[];
}

/** Package metadata gathered by the wizard's "Metadata" step. */
export interface PackageMetadataInput {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  publisher?: string;
  tags?: string[];
}

export interface BuildManifestResult {
  ok: boolean;
  /** Canonical JSON of the validated package (present on success). */
  json?: string;
  package?: FlujoPackage;
  resolved: ResolvedSelection;
  /** Fatal problems that prevented a build (e.g. a local-only MCP server). */
  errors: string[];
  /** Non-fatal advisories (unused secret, missing referenced entity, …). */
  warnings: string[];
}
