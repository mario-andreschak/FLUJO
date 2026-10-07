import type { MCPServerConfig, EnvVarValue } from '@/shared/types/mcp/mcp';
import { isSecretEnvVar, isSecretHeaderKey } from '@/utils/shared/common';
import { isGlobalBinding, isMaskedHeaderValue } from './headers';

const REDACTED = '[REDACTED]';

function valueOf(raw: EnvVarValue | undefined): string {
  if (typeof raw === 'string') return raw;
  return raw && typeof raw.value === 'string' ? raw.value : '';
}

/** Resolve first: stored ciphertext/global bindings are not the wire credential. */
export function collectMcpDiagnosticSecrets(
  configured: MCPServerConfig,
  resolved: MCPServerConfig,
): string[] {
  const secrets = new Set<string>();
  const add = (value: string) => {
    if (!value || isMaskedHeaderValue(value) || isGlobalBinding(value)) return;
    secrets.add(value);
    // Servers commonly echo only the credential portion of an auth header.
    const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
    if (auth) secrets.add(auth[1]);
  };
  for (const [key, raw] of Object.entries(configured.env ?? {})) {
    if (isSecretEnvVar(key) || (raw != null && typeof raw === 'object' && raw.metadata?.isSecret)) {
      add(valueOf(raw));
      add(valueOf(resolved.env?.[key]));
    }
  }
  if ('headers' in configured) {
    const resolvedHeaders = 'headers' in resolved ? resolved.headers : undefined;
    for (const [key, raw] of Object.entries(configured.headers ?? {})) {
      if (isSecretHeaderKey(key) || /^(?:cookie|set-cookie|proxy-authorization)$/i.test(key)
        || (raw != null && typeof raw === 'object' && raw.metadata?.isSecret)) {
        add(valueOf(raw));
        add(valueOf(resolvedHeaders?.[key]));
        if (/^(?:cookie|set-cookie)$/i.test(key)) {
          for (const part of valueOf(resolvedHeaders?.[key]).split(';')) {
            const equals = part.indexOf('=');
            if (equals >= 0) add(part.slice(equals + 1).trim());
          }
        }
      }
    }
  }
  return [...secrets];
}

/** Literal matching avoids regex/replacement interpretation of credential bytes. */
export function createMcpDiagnosticRedactor(values: readonly string[]) {
  const variants = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    variants.add(value);
    try { variants.add(encodeURIComponent(value)); } catch { /* Keep literal/JSON forms of malformed Unicode. */ }
    variants.add(JSON.stringify(value).slice(1, -1));
  }
  const secrets = [...variants].sort((a, b) => b.length - a.length);
  const consume = (text: string, final: boolean): { output: string; pending: string } => {
    let output = '';
    let index = 0;
    while (index < text.length) {
      const remainingLength = text.length - index;
      const partial = secrets.some((secret) => remainingLength < secret.length && secret.startsWith(text.slice(index)));
      // Keep only a possible credential prefix, at most longest credential - 1.
      // Waiting also handles overlapping credentials before choosing the longest match.
      if (partial && !final) break;
      const match = secrets.find((secret) => text.startsWith(secret, index));
      if (match) {
        output += REDACTED;
        index += match.length;
      } else if (partial && final) {
        // Do not disclose a truncated credential prefix at terminal flush.
        output += REDACTED;
        index = text.length;
      } else {
        output += text[index++];
      }
    }
    return { output, pending: text.slice(index) };
  };
  return {
    redact(text: string): string {
      return consume(text, true).output;
    },
    stream() {
      let pending = '';
      return {
        write(chunk: string): string {
          const result = consume(pending + chunk, false);
          pending = result.pending;
          return result.output;
        },
        end(): string {
          const result = consume(pending, true);
          pending = '';
          return result.output;
        },
      };
    },
  };
}
