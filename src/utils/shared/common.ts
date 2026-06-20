/**
 * List of keywords that identify secret environment variables
 */
export const SECRET_ENV_KEYWORDS = ['key', 'secret', 'token', 'password'];

/**
 * Check if an environment variable key should be treated as secret
 * @param key The environment variable key to check
 * @returns True if the key contains any of the secret keywords
 */
export const isSecretEnvVar = (key: string): boolean => 
  SECRET_ENV_KEYWORDS.some(keyword => key.toLowerCase().includes(keyword));


export const toolNameInternalRegex = /_-_-_([\w-^}]+)_-_-_([\w-^}]+)/g;

/**
 * Friendly display name for a model-facing tool function name, for both the
 * current `mcp_<slug>_<hash>` scheme (#16) and the legacy `_-_-_SERVER_-_-_TOOL`
 * scheme used by older conversations. Falls back to the raw name when neither
 * pattern matches (e.g. handoff or external tools).
 */
export const displayToolName = (fnName: string): string => {
  if (!fnName) return fnName;
  if (fnName.includes('_-_-_')) {
    const parts = fnName.split('_-_-_');
    return parts.length === 3 ? parts[2] : fnName;
  }
  const match = /^mcp_(.+)_[0-9a-z]+$/.exec(fnName);
  return match && match[1] ? match[1] : fnName;
};

// Construct the new regex using the source of the first one
// Note the double backslashes needed to escape special characters for the RegExp constructor
export const toolBindingRegex = new RegExp(`\\$\\{${toolNameInternalRegex.source}\\}`, 'g');
