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

/**
 * Regular expression to match tool binding patterns like ${tool-name}
 * Matches simpler patterns with letters, numbers, and limited use of underscores and hyphens
 * Does not match excessive use of special characters or complex patterns
 */
export const toolBindingRegex = /\$\{([a-zA-Z0-9][\w-]{0,20})\}/;