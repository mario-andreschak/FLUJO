/**
 * Secret declarations + the `{{secret.NAME}}` placeholder convention for the
 * FLUJO package manifest format (issue #192).
 *
 * A package declares the secret KEYS it needs (`PackageSecret[]`), and any
 * packaged string may embed a `{{secret.NAME}}` placeholder referring to one of
 * them. Actual secret VALUES are supplied out-of-band at install time and are
 * never part of the manifest.
 */
import { SECRET_PLACEHOLDER_REGEX } from './constants';

/**
 * A secret the package needs the installing host to provide.
 * - `name`: the key referenced by `{{secret.NAME}}` placeholders and explicit
 *   entity refs (`PackagedModel.apiKeyRef`, `EnvDeclaration.secretRef`).
 * - `required`: whether install must block until a value is supplied.
 * - `default`: an optional, NON-secret default (e.g. a sensible public value);
 *   never real secret material.
 */
export interface PackageSecret {
  name: string;
  description?: string;
  required: boolean;
  default?: string;
}

/**
 * List every distinct `{{secret.NAME}}` placeholder found in a single string,
 * in order of first appearance. Returns an empty array for non-strings.
 */
export function listSecretPlaceholders(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const found: string[] = [];
  // Fresh regex per call: the shared constant is /g and stateful.
  const re = new RegExp(SECRET_PLACEHOLDER_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/**
 * Deep-scan an arbitrary value (object / array / string) and collect every
 * distinct `{{secret.NAME}}` placeholder referenced anywhere inside it. Used to
 * verify that every placeholder resolves to a declared `secrets[]` entry.
 */
export function collectSecretPlaceholdersDeep(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const name of listSecretPlaceholders(node)) found.add(name);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const v of Object.values(node as Record<string, unknown>)) visit(v);
    }
  };
  visit(value);
  return Array.from(found);
}
