import { createHash } from 'node:crypto';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { resolveOwnerRequest, assertRemoteAvatarVoiceOrigin, type OwnerRequestAuthorization } from '@/backend/services/security/ownerAccess';
import { isWorkerMode, assertWorkerRequestReady } from '@/backend/services/workspace/workerMode';
import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { workspaceExists } from '@/utils/workspace';
import { PublicError } from '@/vendor/avatar/server/support.mjs';
import type { TrustedAvatarVoiceContext } from './voice';

/** Private BFF-to-worker capability; never a browser header or provider key. */
export const AVATAR_AUTHORIZATION_HEADER = 'x-flujo-avatar-authorization';
const MAX_SCOPES = 128;
const POLL_MS = 250;
interface Scope {
  expiresAt: number;
  controller: AbortController;
  trusted: TrustedAvatarVoiceContext;
  timer?: ReturnType<typeof setInterval>;
}
// A revoked witness stays here until expiry. Restoring old policy bytes must
// not resurrect a receipt whose revocation this process already observed.
const scopes = new Map<string, Scope>();

function ended(status = 401) {
  return new PublicError(status, 'avatar_access_ended', 'Voice access has ended. Reconnect to continue.');
}

function requestBound<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.then(value => {
      if (value instanceof Response) void value.body?.cancel().catch(() => {});
    }, () => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Voice disconnected.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        if (value instanceof Response) void value.body?.cancel().catch(() => {});
        reject(signal.reason);
      } else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function approvedOrigin(request: Request): string {
  const denied = assertRemoteAvatarVoiceOrigin(request);
  if (denied) throw new PublicError(denied.status, 'avatar_origin_denied', 'Remote voice is unavailable.');
  const origin = process.env.FLUJO_AVATAR_REMOTE_ORIGIN!;
  const url = new URL(origin);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new PublicError(503, 'avatar_origin_unconfigured', 'Remote voice is unavailable.');
  }
  return origin;
}

function authenticationRequest(request: Request): Request {
  if (!isWorkerMode()) return request;
  // Worker mode retains its ordinary snapshot bearer on Authorization. Voice
  // additionally requires an independent, workspace-bound owner capability.
  const headers = new Headers();
  const capability = request.headers.get(AVATAR_AUTHORIZATION_HEADER);
  if (capability) headers.set('authorization', capability);
  return new Request(request.url, { method: request.method, headers });
}

function workerDigest(): string {
  return createHash('sha256').update(process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN?.trim() ?? '').digest('hex');
}

function scopeFor(authorization: OwnerRequestAuthorization, origin: string, request: Request): Scope {
  const principal = authorization.principal;
  const workspace = principal.workspaceId!;
  const worker = isWorkerMode(), workerRevision = worker ? workerDigest() : null;
  const readinessProbe = new Request(request.url, { method: request.method });
  const scopeKey = createHash('sha256').update(JSON.stringify([
    principal.ownerId, principal.credentialId, workspace, principal.policyRevision, worker, workerRevision,
  ])).digest('hex');
  for (const [key, scope] of scopes) {
    if (scope.expiresAt <= Date.now()) {
      scope.controller.abort(ended()); clearInterval(scope.timer); scopes.delete(key);
    }
  }
  const existing = scopes.get(scopeKey);
  if (existing) return existing;
  if (scopes.size >= MAX_SCOPES) throw new PublicError(429, 'avatar_scopes_busy', 'Voice is busy. Try again shortly.');
  const controller = new AbortController();
  let checking: Promise<void> | undefined;
  const scope: Scope = { expiresAt: principal.expiresAt, controller, trusted: undefined as never };
  const currentAuthority = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const denied = authorization.recheck();
    if (denied) throw ended(denied.status);
    if (process.env.FLUJO_AVATAR_REMOTE_ORIGIN !== origin) throw ended();
    if (isWorkerMode() !== worker || worker && workerDigest() !== workerRevision) throw ended();
    if (worker) {
      const unavailable = assertWorkerRequestReady(readinessProbe, workspace);
      if (unavailable) throw ended(unavailable.status);
    }
  };
  const rejectScope = (error: unknown) => {
    const refusal = error instanceof PublicError ? error : ended(503);
    controller.abort(refusal); clearInterval(scope.timer); return refusal;
  };
  const check = (): Promise<void> => {
    // A slow filesystem read must not starve durable revocation polling.
    try { currentAuthority(); } catch (error) { return Promise.reject(rejectScope(error)); }
    if (checking) return checking;
    checking = (async () => {
      try {
        const exists = await new Promise<boolean>((resolve, reject) => {
          const abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
          void workspaceExists(workspace).then(resolve, reject)
            .finally(() => controller.signal.removeEventListener('abort', abort));
        });
        if (!exists) throw ended(403);
        // Workspace checking can yield. Recheck durable authority before effect.
        currentAuthority();
      } catch (error) {
        throw rejectScope(error);
      }
    })().finally(() => { checking = undefined; });
    return checking;
  };
  scope.trusted = Object.freeze({ workspace, scopeKey, revokeSignal: controller.signal, recheck: check });
  scope.timer = setInterval(() => { void check().catch(() => {}); }, POLL_MS);
  scope.timer.unref?.();
  scopes.set(scopeKey, scope);
  return scope;
}

/** Graceful host shutdown and disposable test cleanup, never exposed as an API. */
export function disposeAvatarRemoteScopes(): void {
  for (const scope of scopes.values()) { clearInterval(scope.timer); scope.controller.abort(ended()); }
  scopes.clear();
}

function pinnedRequest(request: Request, workspace: string, signal: AbortSignal): Request {
  const url = new URL(request.url);
  const selected = url.searchParams.getAll('workspace');
  const header = request.headers.get('x-flujo-workspace');
  if (selected.length > 1 || selected.some(value => value !== workspace) || (header !== null && header !== workspace)) {
    throw new PublicError(403, 'avatar_workspace_denied', 'Forbidden');
  }
  url.searchParams.set('workspace', workspace);
  const headers = new Headers(request.headers);
  headers.set('x-flujo-workspace', workspace);
  return new Request(url, { method: request.method, headers, signal,
    ...(request.body ? { body: request.body, duplex: 'half' } : {}) } as RequestInit);
}

function streamResponse(response: Response, request: Request, scope: Scope, disconnect: AbortController): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const signal = AbortSignal.any([request.signal, scope.controller.signal]);
  let done = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => { done = true; signal.removeEventListener('abort', abort); };
  const release = () => { try { reader.releaseLock(); } catch { /* pending read owns the lock */ } };
  const abort = () => {
    if (done) return;
    finish(); void reader.cancel(signal.reason).finally(release).catch(() => {});
    output.error(signal.reason ?? new DOMException('Voice disconnected.', 'AbortError'));
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); },
    async pull(controller) {
      if (done) return;
      try {
        await requestBound(scope.trusted.recheck(), signal);
        const item = await requestBound(reader.read(), signal);
        await requestBound(scope.trusted.recheck(), signal);
        if (done) return;
        if (item.done) { finish(); release(); controller.close(); }
        else controller.enqueue(item.value);
      } catch (error) {
        if (done) return;
        finish(); disconnect.abort(error); void reader.cancel(error).finally(release).catch(() => {}); controller.error(error);
      }
    },
    async cancel(reason) { if (done) return; finish(); disconnect.abort(reason); await reader.cancel(reason).finally(release).catch(() => {}); },
  });
  const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** Authenticate before body/storage, then select only the policy's workspace. */
export function withRemoteAvatarRoute<R extends unknown[]>(
  handler: (request: Request, trusted: TrustedAvatarVoiceContext, ...rest: R) => Response | Promise<Response>,
): (request: Request, ...rest: R) => Promise<Response> {
  return async (request, ...rest) => {
    // Both independent capabilities must pass before any workspace read.
    if (isWorkerMode()) {
      const denied = assertSnapshotBearer(request);
      if (denied) return denied;
    }
    const resolved = resolveOwnerRequest(authenticationRequest(request), ['avatar:voice'], { requireWorkspace: true });
    if (!resolved.ok) return resolved.response;
    const disconnect = new AbortController();
    try {
      const origin = approvedOrigin(request);
      const scope = scopeFor(resolved.authorization, origin, request);
      await requestBound(scope.trusted.recheck(), request.signal);
      const selected = pinnedRequest(request, scope.trusted.workspace, AbortSignal.any([request.signal, disconnect.signal]));
      const scoped = withWorkspaceRoute(async (admitted: Request) => {
        await requestBound(scope.trusted.recheck(), admitted.signal);
        return handler(admitted, scope.trusted, ...rest);
      });
      const response = await requestBound(scoped(selected), selected.signal);
      await requestBound(scope.trusted.recheck(), selected.signal);
      return streamResponse(response, selected, scope, disconnect);
    } catch (error) {
      disconnect.abort(error);
      const known = error instanceof PublicError;
      return Response.json({ error: known ? error.message : 'Remote voice is unavailable.',
        code: known ? error.code : 'avatar_remote_unavailable' }, {
        status: known ? error.status : 503, headers: { 'Cache-Control': 'no-store' },
      });
    }
  };
}
