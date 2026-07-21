/**
 * Constants for the FLUJO package manifest format (`FlujoPackage` v1, issue #192).
 *
 * Pure/isomorphic: this module (and everything under `src/shared/types/package/`)
 * must run unchanged in the browser wizard, the registry API backstop, and the
 * install path. No Node- or browser-only APIs.
 */

/**
 * The only `FlujoPackage.schemaVersion` this build understands. A numeric
 * literal (distinct from the string `'1'` used by the older install-focused
 * `PackageManifest` in `../packages/manifest.ts`). Bump this — and add a
 * migration — when the manifest shape changes incompatibly.
 */
export const PACKAGE_SCHEMA_VERSION = 1 as const;

/**
 * Upper bound on the size of a serialized package (the single JSON blob the
 * registry stores). 2 MB is large enough for several full ReactFlow flows while
 * keeping registry storage sane. Enforced by the (de)serialization helpers.
 */
export const MANIFEST_SIZE_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Matches a `{{secret.NAME}}` placeholder anywhere inside a packaged string.
 * The capture group is the secret name. Alphabet: `A-Za-z0-9_.-` (compatible
 * with brain online's existing `PackageManifest` secret-key naming). Global so
 * a single string may carry several placeholders.
 */
export const SECRET_PLACEHOLDER_REGEX = /\{\{secret\.([A-Za-z0-9_.-]+)\}\}/g;

/**
 * Prefix FLUJO writes in front of every encrypted-at-rest value (API keys,
 * secret env/header values, webhook tokens, OAuth secrets). A package must
 * NEVER contain a value beginning with this — it would leak ciphertext. The
 * schema and serializer both hard-reject it as a backstop.
 */
export const ENCRYPTED_PREFIX = 'encrypted:';

/**
 * Matches a whole-string `${global:VAR}` binding — a portable, secret-free
 * reference to a host-provided global variable (resolved fresh at runtime by
 * `resolveGlobalVars`). The capture group is the variable name.
 */
export const GLOBAL_VAR_REGEX = /^\$\{global:([A-Za-z0-9_.-]+)\}$/;

/** Alphabet allowed for secret names and global-variable names. */
export const IDENTIFIER_REGEX = /^[A-Za-z0-9_.-]+$/;

/**
 * Semantic-version validator (MAJOR.MINOR.PATCH with optional pre-release /
 * build metadata). Used for `FlujoPackage.version`.
 */
export const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
