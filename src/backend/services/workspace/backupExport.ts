/** Ordinary exports omit credential stores and executable server files. */
export const ORDINARY_BACKUP_SELECTIONS = ['models', 'mcpServers', 'flows', 'chatHistory', 'settings', 'globalEnvVars'] as const;

const credentialFields = new Set([
  'apikey', 'password', 'passphrase', 'secret', 'token', 'accesstoken', 'refreshtoken',
  'clientsecret', 'oauthclientsecret', 'oauthclientinformation', 'oauthtokens',
  'oauthcodeverifier', 'authorization', 'cookie', 'privatekey', 'encryptionkey',
  'baseurl',
]);

/**
 * Strip structured credential material, including legacy failed-encryption
 * envelopes. User-authored text is preserved and still needs review before
 * sharing; this is not a classifier for secrets embedded in prose or code.
 */
export function redactBackupCredentials(value: unknown): unknown {
  if (typeof value === 'string') {
    return /^(encrypted:|encrypted_failed:)/.test(value) ? undefined : value;
  }
  if (Array.isArray(value)) return value.map(redactBackupCredentials).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const secret = record.metadata && typeof record.metadata === 'object'
    && (record.metadata as Record<string, unknown>).isSecret === true;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (credentialFields.has(key.replace(/[_-]/g, '').toLowerCase()) || (secret && key === 'value')) continue;
    const sanitized = redactBackupCredentials(item);
    if (sanitized !== undefined) Object.defineProperty(result, key, { value: sanitized, enumerable: true });
  }
  return result;
}

/** What an ordinary export writes for every variable: its name only, never its value. */
export const WITHHELD_VARIABLE = Object.freeze({ value: '', metadata: Object.freeze({ isSecret: true }) });

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function isWithheldVariable(entry: unknown): boolean {
  const record = asRecord(entry);
  return record.value === '' && asRecord(record.metadata).isSecret === true;
}

/**
 * Restoring variables never loses a value. Exports carry names only, so a
 * withheld entry keeps the value stored under that name, and stored variables
 * the archive does not list stay as they are. A withheld name that is not
 * stored yet is added empty, so the user sees it still needs a value. Values
 * from older archives that still carried them are restored.
 */
export function mergeRestoredVariables(current: unknown, archived: unknown): Record<string, unknown> {
  const stored = asRecord(current);
  const merged: Record<string, unknown> = {};
  const put = (name: string, entry: unknown) => Object.defineProperty(merged, name, { value: entry, enumerable: true, writable: true, configurable: true });
  for (const [name, entry] of Object.entries(stored)) put(name, entry);
  for (const [name, entry] of Object.entries(asRecord(archived))) {
    if (!(isWithheldVariable(entry) && Object.hasOwn(stored, name))) put(name, entry);
  }
  return merged;
}

export function ordinaryBackupData(selection: string, value: unknown): unknown {
  if (selection === 'globalEnvVars') {
    // Unmarked legacy variables can contain credentials: no values are exported.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.keys(value).map(name => [name, { value: WITHHELD_VARIABLE.value, metadata: { ...WITHHELD_VARIABLE.metadata } }]));
  }
  if (selection === 'mcpServers') {
    // Launch strings, URLs, headers, source URLs and arbitrary nested transport
    // options can carry credentials. Export only descriptive config fields.
    const fields = ['name', 'transport', 'description', 'folder', 'favorite', 'disabled'];
    const sanitize = (entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
      return redactBackupCredentials(Object.fromEntries(fields.filter(key => Object.hasOwn(entry, key))
        .map(key => [key, (entry as Record<string, unknown>)[key]])));
    };
    return Array.isArray(value) ? value.map(sanitize) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)])) : {};
  }
  return redactBackupCredentials(value);
}
