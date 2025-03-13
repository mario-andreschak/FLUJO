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


export const toolBindingRegex = /\$\{_-_-_([\w-^}]+)_-_-_([\w-^}]+)\}/g;