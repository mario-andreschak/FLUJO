/**
 * Frontend service for package-registry account handling (issue #197).
 *
 * Thin fetch wrapper over the local-only `/api/registry/*` routes, following the
 * packageService singleton/proxy pattern. Never handles plaintext tokens — the
 * backend stores/decrypts them; the browser only ever sees masked status.
 */
import { createLogger } from '@/utils/logger';
import type {
  RegistryAccountStatus,
  RegistryAuthAction,
  RegistryAuthResult,
  RegistryPublishResult,
} from '@/shared/types/registry';

const log = createLogger('frontend/services/registry');

export interface RegistrySettingsView {
  baseUrl: string;
  usingDefault: boolean;
  defaultUrl: string;
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  return body as T;
}

class RegistryService {
  async getStatus(): Promise<RegistryAccountStatus> {
    const response = await fetch('/api/registry/auth', { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parse<RegistryAccountStatus>(response);
  }

  private async auth(action: RegistryAuthAction, email: string, password: string): Promise<RegistryAuthResult> {
    const response = await fetch('/api/registry/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, email, password }),
    });
    const body = await parse<RegistryAuthResult & { error?: string }>(response);
    if (!response.ok && body?.status === undefined) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return body;
  }

  signup(email: string, password: string): Promise<RegistryAuthResult> {
    return this.auth('signup', email, password);
  }

  login(email: string, password: string): Promise<RegistryAuthResult> {
    return this.auth('login', email, password);
  }

  async logout(): Promise<void> {
    const response = await fetch('/api/registry/auth', { method: 'DELETE' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  async resendConfirmation(email?: string): Promise<{ success: boolean; message?: string }> {
    const response = await fetch('/api/registry/auth/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(email ? { email } : {}),
    });
    return parse<{ success: boolean; message?: string }>(response);
  }

  async getSettings(): Promise<RegistrySettingsView> {
    const response = await fetch('/api/registry/settings', { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parse<RegistrySettingsView>(response);
  }

  async saveSettings(baseUrl: string): Promise<{ success: boolean; message?: string }> {
    const response = await fetch('/api/registry/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl }),
    });
    return parse<{ success: boolean; message?: string }>(response);
  }

  /** Publish a built manifest object; returns the structured publish result. */
  async publish(manifest: unknown): Promise<RegistryPublishResult> {
    const response = await fetch('/api/registry/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest }),
    });
    const body = await parse<RegistryPublishResult>(response);
    if (body?.ok === undefined) {
      log.warn('Unexpected publish response shape', { status: response.status });
      return { ok: false, code: 'error', error: `HTTP ${response.status}` };
    }
    return body;
  }
}

let _registryService: RegistryService | null = null;

export const getRegistryService = (): RegistryService => {
  if (typeof window === 'undefined') {
    throw new Error('RegistryService can only be used in browser environment');
  }
  if (!_registryService) {
    _registryService = new RegistryService();
  }
  return _registryService;
};

// Lazy proxy so importing this module never throws during SSR/prerender.
export const registryService: RegistryService = new Proxy({} as RegistryService, {
  get(_target, prop) {
    const service = getRegistryService();
    const value = (service as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(service) : value;
  },
});

export type { RegistryAccountStatus, RegistryAuthResult, RegistryPublishResult };
