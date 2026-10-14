import { randomUUID } from 'node:crypto';
import { Agent, fetch as ownerFetch } from 'undici';
import {
  assertExecutionModelStepNodeId, MAX_EXECUTION_MODEL_STEP_ORDINAL,
  type ExecutionBoundModelIdentity, type ExecutionModelStepSlot, type ExecutionOwnerModelDispatchRequest,
} from '@/backend/execution/extensions';
import { modelService } from '@/backend/services/model';
import { resolveCompletionAdapterRoute } from '@/backend/services/model/adapters/completionRoute';
import { PROTECTED_OPENAI_DEFAULT_BASE_URL } from '@/backend/services/model/openaiClient';
import { decryptWithPassword } from '@/utils/encryption/secure';
import type { Model } from '@/shared/types/model';
import { assertOriginalApproval } from './administration';
import { assertOriginalOwnerAuthority, type OriginalOwnerAuthority } from './authority';
import { mutateOriginalOwnerBook, flushOriginalOwnerBook, readOriginalOwnerBook } from './store';
import {
  accountModelPlan, bytesDigest, ownerDigest, OriginalOwnerError, refuse,
  type OriginalOwnerBook, type OriginalOwnerStep,
} from './types';

declare const stepBrand: unique symbol;
/** An in-process child of a genuine original Persona root, never request JSON. */
export interface OriginalOwnerModelStep { readonly [stepBrand]: true }
type IssuedStep = {
  authority: OriginalOwnerAuthority; id: string; authorityDigest: string;
  model: ExecutionBoundModelIdentity; slot: Readonly<ExecutionModelStepSlot>; consumed: boolean;
};
const root = globalThis as typeof globalThis & {
  __flujoOriginalOwnerModelSteps?: WeakMap<object, IssuedStep>;
  __flujoOriginalOwnerActiveSends?: Map<string, string>;
  __flujoOriginalOwnerTransport?: Agent;
};
const issued = root.__flujoOriginalOwnerModelSteps ??= new WeakMap<object, IssuedStep>();
const activeSends = root.__flujoOriginalOwnerActiveSends ??= new Map<string, string>();
// The admitted SDK/caller signal owns the lifetime; this sender introduces no
// inference deadline or retry dispatcher. Share the pool across server graphs.
const transport = root.__flujoOriginalOwnerTransport ??= new Agent({ pipelining: 0, headersTimeout: 0, bodyTimeout: 0 });
const MODEL_BODY_LIMIT = 64 * 1024 * 1024;
const RECHECK_MS = 250;
const safeHeaders = new Set([
  'accept', 'content-type', 'user-agent', 'http-referer', 'x-title',
  'openai-organization', 'openai-project', 'x-stainless-arch', 'x-stainless-lang',
  'x-stainless-os', 'x-stainless-package-version', 'x-stainless-retry-count',
  'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-timeout',
]);
const routing = [
  ['openai-organization', 'openaiOrganization'], ['openai-project', 'openaiProject'],
  ['http-referer', 'httpReferer'], ['x-title', 'xTitle'],
] as const;

function record(value: unknown): IssuedStep {
  const result = value && typeof value === 'object' ? issued.get(value) : undefined;
  if (!result) refuse('original_owner_model_step_required');
  assertOriginalOwnerAuthority(result.authority);
  return result;
}
export function assertOriginalOwnerModelStep(value: unknown): asserts value is OriginalOwnerModelStep { record(value); }
export function originalOwnerModelStepAuthority(value: unknown): OriginalOwnerAuthority | undefined {
  if (!value || typeof value !== 'object' || !issued.has(value)) return undefined;
  return record(value).authority;
}
export async function assertOriginalOwnerModelStepCurrent(value: unknown): Promise<void> {
  const step = record(value);
  await step.authority.assertModelPlan({ nodeId: step.slot.nodeId, modelId: step.model.id });
}
export async function originalOwnerModelStepRouting(value: unknown): Promise<Readonly<OriginalOwnerBook['accounts'][number]['routingHeaders']>> {
  const step = record(value);
  await assertOriginalOwnerModelStepCurrent(value);
  const { account } = await currentRecords(await readOriginalOwnerBook(), step.authority, step.model);
  return Object.freeze({ ...account.routingHeaders });
}
async function reconcileUnobservedSends(book: OriginalOwnerBook, enrollmentId: string) {
  let changed = false;
  for (const row of book.steps) {
    if (row.kind === 'model' && row.enrollmentId === enrollmentId && row.state === 'sending'
      && activeSends.get(row.id) !== row.senderId) {
      row.state = 'unknown'; row.updatedAt = Date.now(); changed = true;
    }
  }
  if (changed) await flushOriginalOwnerBook();
}
function identity(model: Pick<Model, 'id' | 'name' | 'adapter' | 'provider' | 'baseUrl' | 'ownerCredentialBinding'>): ExecutionBoundModelIdentity {
  if (!model.ownerCredentialBinding) refuse('original_owner_model_binding_required');
  return { id: model.id, name: model.name, adapter: model.adapter, provider: model.provider,
    baseUrl: model.baseUrl, ownerCredentialBinding: { ...model.ownerCredentialBinding } };
}
async function currentRecords(book: OriginalOwnerBook, authority: OriginalOwnerAuthority, model?: ExecutionBoundModelIdentity) {
  const binding = authority.binding;
  const enrollment = book.enrollments.find(value => value.id === binding.enrollmentId);
  const account = book.accounts.find(value => value.id === binding.accountId);
  if (!enrollment || enrollment.state !== 'active' || enrollment.workspace !== binding.workspace
    || enrollment.ownerId !== binding.ownerId || enrollment.personaId !== binding.personaId
    || enrollment.taskId !== binding.taskId || enrollment.accountId !== binding.accountId
    || enrollment.modelId !== binding.modelId || !account || account.state !== 'active'
    || account.kind !== 'openai' || account.ownerId !== binding.ownerId || account.modelId !== binding.modelId
    || account.modelDigest !== binding.modelDigest) refuse('original_owner_account_changed');
  assertOriginalApproval(enrollment.approval); assertOriginalApproval(account.approval);
  const saved = await modelService.getModel(binding.modelId);
  if (!saved || saved.ApiKey !== '' || saved.fallbackPolicy || resolveCompletionAdapterRoute(saved) !== 'openai'
    || saved.ownerCredentialBinding?.ownerId !== account.ownerId
    || saved.ownerCredentialBinding?.credentialId !== account.id
    || ownerDigest(accountModelPlan(saved)) !== account.modelDigest
    || (model && ownerDigest(identity(saved)) !== ownerDigest(model))) refuse('original_owner_model_changed');
  return { account, enrollment, saved };
}

/** The graph call-site and logical ordinal survive a new process/lease. A new
 * lease must never turn a lost receipt into a fresh physical inference. */
export async function issueOriginalOwnerModelStep(
  authority: OriginalOwnerAuthority, model: ExecutionBoundModelIdentity, slot: ExecutionModelStepSlot,
): Promise<OriginalOwnerModelStep> {
  assertOriginalOwnerAuthority(authority);
  if (!slot || !Number.isSafeInteger(slot.ordinal) || slot.ordinal < 0 || slot.ordinal > MAX_EXECUTION_MODEL_STEP_ORDINAL) {
    refuse('original_owner_model_slot_invalid');
  }
  assertExecutionModelStepNodeId(slot.nodeId);
  const capturedModel = identity(model);
  const capturedSlot = Object.freeze({ nodeId: slot.nodeId, ordinal: slot.ordinal });
  await authority.assertModelPlan({ nodeId: capturedSlot.nodeId, modelId: capturedModel.id });
  const binding = authority.binding;
  const id = ownerDigest([binding.workspace, binding.enrollmentId, binding.originalRunId, slot.nodeId, slot.ordinal]);
  const authorityDigest = ownerDigest(binding);
  await authority.commitWhileCurrent(async () => mutateOriginalOwnerBook(async book => {
    const { enrollment } = await currentRecords(book, authority, capturedModel);
    await reconcileUnobservedSends(book, enrollment.id);
    if (book.steps.some(value => value.kind === 'model' && value.enrollmentId === enrollment.id && value.state === 'unknown')) {
      refuse('original_owner_model_outcome_unknown');
    }
    const previous = book.steps.find(value => value.id === id);
    if (previous) {
      if (previous.kind !== 'model' || previous.enrollmentId !== binding.enrollmentId
        || previous.accountId !== binding.accountId || previous.originalRunId !== binding.originalRunId
        || previous.modelDigest !== binding.modelDigest || previous.nodeId !== slot.nodeId
        || previous.ordinal !== slot.ordinal) refuse('original_owner_model_slot_changed');
      if (previous.state !== 'issued') {
        refuse('original_owner_model_step_spent');
      }
      previous.leaseId = binding.leaseId; previous.authorityDigest = authorityDigest; previous.updatedAt = Date.now();
      return;
    }
    if (enrollment.budget.maxModelSteps !== null && book.steps.filter(value =>
      value.enrollmentId === enrollment.id && value.kind === 'model').length >= enrollment.budget.maxModelSteps) {
      refuse('original_owner_model_budget_exhausted');
    }
    const now = Date.now();
    book.steps.push({ id, enrollmentId: enrollment.id, accountId: binding.accountId, kind: 'model',
      originalRunId: binding.originalRunId, leaseId: binding.leaseId, modelDigest: binding.modelDigest,
      nodeId: slot.nodeId, ordinal: slot.ordinal, authorityDigest, state: 'issued', usage: null,
      createdAt: now, updatedAt: now });
  }));
  const result = Object.freeze({}) as OriginalOwnerModelStep;
  issued.set(result, { authority, id, authorityDigest, model: capturedModel, slot: capturedSlot, consumed: false });
  return result;
}

function endpoint(model: ExecutionBoundModelIdentity): string {
  const base = model.baseUrl ?? PROTECTED_OPENAI_DEFAULT_BASE_URL;
  try {
    const parsed = new URL(base);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error();
    return new URL(`${base}${base.endsWith('/') ? '' : '/'}chat/completions`).toString();
  } catch { return refuse('original_owner_endpoint_invalid'); }
}
type Wire = { request: ExecutionOwnerModelDispatchRequest; outputLimit: number | null; choices: number };
function snapshot(request: ExecutionOwnerModelDispatchRequest, model: ExecutionBoundModelIdentity): Wire {
  if (!request || request.version !== 2 || request.method !== 'POST'
    || !['chat.completions.create', 'chat.completions.create(stream)'].includes(request.operation)
    || ownerDigest(identity(request.model)) !== ownerDigest(model) || request.url !== endpoint(model)
    || !(request.body instanceof Uint8Array) || request.body.byteLength > MODEL_BODY_LIMIT || !Array.isArray(request.headers)) {
    refuse('original_owner_wire_mismatch');
  }
  const headers: [string, string][] = [];
  for (const pair of request.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
      || !safeHeaders.has(pair[0]) || (headers.length && headers[headers.length - 1][0] >= pair[0])) {
      refuse('original_owner_wire_mismatch');
    }
    try {
      if (new Headers([pair as [string, string]]).get(pair[0]) !== pair[1]) refuse('original_owner_wire_mismatch');
    } catch { refuse('original_owner_wire_mismatch'); }
    headers.push([pair[0], pair[1]]);
  }
  const body = Uint8Array.from(request.body);
  const header = (name: string) => headers.find(([key]) => key === name)?.[1] ?? null;
  if (header('content-type') !== 'application/json' || bytesDigest(body) !== request.bodySha256
    || bytesDigest(JSON.stringify(headers)) !== request.headersSha256 || !request.routingHeaderSha256) {
    refuse('original_owner_wire_mismatch');
  }
  for (const [name, key] of routing) {
    const value = header(name);
    if (request.routingHeaderSha256[key] !== (value === null ? null : bytesDigest(value))) refuse('original_owner_wire_mismatch');
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return refuse('original_owner_body_invalid'); }
  const streaming = request.operation === 'chat.completions.create(stream)';
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.model !== model.name
    || (streaming ? parsed.stream !== true : parsed.stream !== undefined && parsed.stream !== false)) {
    refuse('original_owner_body_invalid');
  }
  const caps = [parsed.max_tokens, parsed.max_completion_tokens].filter(value => value !== undefined);
  if (caps.length > 1 || caps.some(value => !Number.isSafeInteger(value) || (value as number) <= 0)) refuse('original_owner_output_limit_invalid');
  const choices = parsed.n === undefined ? 1 : parsed.n;
  if (!Number.isSafeInteger(choices) || (choices as number) < 1) refuse('original_owner_output_limit_invalid');
  const outputLimit = caps.length ? (caps[0] as number) * (choices as number) : null;
  if (outputLimit !== null && !Number.isSafeInteger(outputLimit)) refuse('original_owner_output_limit_invalid');
  return { request: { ...request, headers, body, model: { ...model, ownerCredentialBinding: { ...model.ownerCredentialBinding } },
    routingHeaderSha256: { ...request.routingHeaderSha256 } }, outputLimit, choices: choices as number };
}
function reservedOutput(step: OriginalOwnerStep): number | null {
  if (!step.senderId) return 0;
  if (step.state === 'completed' && step.usage?.outputTokens !== null && step.usage?.outputTokens !== undefined) {
    return step.usage.outputTokens;
  }
  return step.maxOutputTokens ?? null;
}
function assertWireAccount(wire: Wire, account: OriginalOwnerBook['accounts'][number]) {
  for (const [name] of routing) {
    if ((wire.request.headers.find(([key]) => key === name)?.[1] ?? null) !== (account.routingHeaders[name] ?? null)) {
      refuse('original_owner_routing_changed');
    }
  }
}
type Usage = { inputTokens: number | null; outputTokens: number | null };
const missingUsage = (): Usage => ({ inputTokens: null, outputTokens: null });
const counter = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
function usage(value: unknown): Usage {
  if (!value || typeof value !== 'object') return missingUsage();
  const record = value as Record<string, unknown>;
  return { inputTokens: counter(record.prompt_tokens), outputTokens: counter(record.completion_tokens) };
}

/** Incremental accounting observes the bytes delivered to the SDK; it does not
 * consume a second stream or infer successful inference from HTTP headers. */
class Receipt {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private text = '';
  private event: string[] = [];
  private eventLength = 0;
  private eventName: string | undefined;
  private finished = new Set<number>();
  private ended = false;
  private invalid = false;
  private providerError = false;
  private content = false;
  usage = missingUsage();
  constructor(private streaming: boolean, private choices: number) {}
  get hasError() { return this.providerError; }
  get errorState(): 'unknown' | 'rejected' { return this.content ? 'unknown' : 'rejected'; }
  get completedSentinel() {
    return this.streaming && this.ended && !this.invalid && !this.providerError
      && !this.text && !this.event.length && this.finished.size === this.choices;
  }
  add(bytes: Uint8Array) {
    try {
      this.text += this.decoder.decode(bytes, { stream: true });
      if (this.text.length > MODEL_BODY_LIMIT) throw new Error();
      if (this.streaming) this.lines(false);
    } catch { this.invalid = true; }
  }
  private lines(final: boolean) {
    let end: number;
    while ((end = this.text.search(/[\r\n]/)) >= 0) {
      if (!final && this.text[end] === '\r' && end === this.text.length - 1) break;
      const line = this.text.slice(0, end);
      this.text = this.text.slice(end + (this.text.slice(end, end + 2) === '\r\n' ? 2 : 1));
      if (!line) this.frame();
      else if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, ''); this.event.push(data); this.eventLength += data.length;
      } else if (line.startsWith('event:')) this.eventName = line.slice(6).replace(/^ /, '');
      if (this.eventLength > MODEL_BODY_LIMIT) throw new Error();
    }
  }
  private frame() {
    const eventName = this.eventName; this.eventName = undefined;
    if (!this.event.length) return;
    const text = this.event.join('\n'); this.event = []; this.eventLength = 0;
    if (text === '[DONE]') { this.ended = true; return; }
    if (this.ended) { this.invalid = true; return; }
    if (eventName === 'error') this.providerError = true;
    const value = JSON.parse(text) as Record<string, unknown>;
    this.inspect(value);
  }
  private inspect(value: Record<string, unknown>) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { this.invalid = true; return; }
    if (value.error) this.providerError = true;
    if (value.usage !== undefined && value.usage !== null) this.usage = usage(value.usage);
    if (Array.isArray(value.choices)) {
      for (const candidate of value.choices) {
        if (!candidate || typeof candidate !== 'object') { this.invalid = true; continue; }
        const choice = candidate as Record<string, unknown>;
        if (!Number.isSafeInteger(choice.index) || (choice.index as number) < 0 || (choice.index as number) >= this.choices) {
          this.invalid = true; continue;
        }
        if (typeof choice.finish_reason === 'string'
          && choice.finish_reason.length) this.finished.add(choice.index as number);
        const output = choice.delta ?? choice.message;
        if (output && typeof output === 'object' && ['content', 'refusal', 'tool_calls', 'function_call', 'audio', 'reasoning_content']
          .some(key => (output as Record<string, unknown>)[key] !== undefined
            && (output as Record<string, unknown>)[key] !== null && (output as Record<string, unknown>)[key] !== '')) {
          this.content = true;
        }
      }
    }
  }
  finish(): 'completed' | 'rejected' | 'unknown' {
    try {
      this.text += this.decoder.decode();
      if (this.streaming) {
        this.lines(true);
        // A final unterminated SSE frame cannot stand in for a complete receipt.
        if (this.text || this.event.length) this.invalid = true;
      } else {
        this.inspect(JSON.parse(this.text)); this.ended = true;
      }
    } catch { this.invalid = true; }
    if (this.invalid) return 'unknown';
    if (this.providerError) return this.content ? 'unknown' : 'rejected';
    return this.ended && this.finished.size === this.choices ? 'completed' : 'unknown';
  }
}

function safeFailure(code: string, status = 403) { return new OriginalOwnerError(code, status); }
async function settle(step: IssuedStep, senderId: string | undefined, state: OriginalOwnerStep['state'],
  detail: { status?: number; usage?: Usage; physicalSend?: boolean } = {}) {
  const commit = () => mutateOriginalOwnerBook(async book => {
    if (state === 'completed') await currentRecords(book, step.authority, step.model);
    const row = book.steps.find(value => value.id === step.id);
    if (!row || (senderId ? row.senderId !== senderId || !['sending', 'unknown'].includes(row.state)
      : row.state !== 'issued' || row.authorityDigest !== step.authorityDigest)) return;
    row.state = state; row.updatedAt = Date.now();
    if (detail.physicalSend === false) row.senderId = undefined;
    if (detail.status !== undefined) row.status = detail.status;
    if (detail.usage) row.usage = detail.usage;
  });
  if (state === 'completed') await step.authority.commitWhileCurrent(commit);
  else await commit();
}

/** A durable owner CAS and fsync precede the sole physical fetch invocation.
 * Only invocation occurs under Persona/account fences; response waits and every
 * body read happen after those locks have been released. */
export async function dispatchOriginalOwnerModelRequest(value: unknown, input: ExecutionOwnerModelDispatchRequest): Promise<Response> {
  const step = record(value);
  if (step.consumed) refuse('original_owner_model_step_spent');
  step.consumed = true;
  let wire: Wire;
  try { wire = snapshot(input, step.model); }
  catch {
    await settle(step, undefined, 'rejected');
    throw safeFailure('original_owner_wire_mismatch');
  }
  const request = wire.request;
  const abortSignal = request.signal ? AbortSignal.any([request.signal, step.authority.signal]) : step.authority.signal;
  const controller = new AbortController();
  const senderId = randomUUID();
  let pending: Promise<Response> | undefined;
  let claimed = false;
  try {
    await step.authority.assertModelPlan({ nodeId: step.slot.nodeId, modelId: step.model.id });
    await step.authority.commitWhileCurrent(async () => mutateOriginalOwnerBook(async book => {
      const { account, enrollment, saved } = await currentRecords(book, step.authority, step.model);
      await reconcileUnobservedSends(book, enrollment.id);
      const row = book.steps.find(value => value.id === step.id);
      if (!row || row.state !== 'issued' || row.authorityDigest !== step.authorityDigest) refuse('original_owner_model_step_spent');
      if (book.steps.some(value => value.id !== row.id && value.kind === 'model' && value.enrollmentId === enrollment.id
        && value.state === 'unknown')) refuse('original_owner_model_outcome_unknown');
      assertWireAccount(wire, account);
      if (saved.maxTokens !== undefined && (wire.outputLimit === null || wire.outputLimit / wire.choices !== saved.maxTokens)) {
        refuse('original_owner_output_limit_changed');
      }
      if (enrollment.budget.maxOutputTokens !== null) {
        const previous = book.steps.filter(value => value.id !== row.id && value.enrollmentId === enrollment.id && value.kind === 'model')
          .map(reservedOutput);
        if (wire.outputLimit === null || previous.some(value => value === null)
          || previous.reduce<number>((total, value) => total + (value ?? 0), 0) + wire.outputLimit > enrollment.budget.maxOutputTokens) {
          refuse('original_owner_output_budget_exhausted');
        }
      }
      // Account credentials are encrypted private records. Do not invoke the
      // general model/global-variable resolver or accept historical plaintext.
      if (!account.credential.startsWith('encrypted:')) refuse('original_owner_credential_unavailable');
      const credential = await decryptWithPassword(account.credential.slice('encrypted:'.length));
      if (!credential?.trim() || /[\r\n]/.test(credential) || credential !== credential.trim()) refuse('original_owner_credential_unavailable');
      if (abortSignal.aborted) refuse('original_owner_model_aborted');
      const headers = new Headers(request.headers as [string, string][]);
      headers.set('authorization', `Bearer ${credential}`);
      row.state = 'sending'; row.senderId = senderId; row.operation = request.operation;
      row.bodyDigest = request.bodySha256; row.headersDigest = request.headersSha256;
      row.urlDigest = bytesDigest(request.url); row.routingDigest = ownerDigest(request.routingHeaderSha256);
      row.maxOutputTokens = wire.outputLimit; row.updatedAt = Date.now();
      claimed = true;
      await flushOriginalOwnerBook();
      // The Original capability recognizes this exact active Persona fence and
      // refreshes persisted joins without acquiring that Persona lock again.
      // In particular, a lease can expire while the durability barrier waits.
      await step.authority.assertCurrent();
      assertOriginalApproval(enrollment.approval); assertOriginalApproval(account.approval);
      if (abortSignal.aborted) {
        row.state = 'aborted'; row.senderId = undefined; row.updatedAt = Date.now(); await flushOriginalOwnerBook();
        refuse('original_owner_model_aborted');
      }
      // No redirect, retry wrapper, SDK or global fetch may open another socket.
      activeSends.set(step.id, senderId);
      pending = ownerFetch(request.url, { method: 'POST', headers, body: request.body,
        redirect: 'manual', signal: controller.signal, dispatcher: transport }) as unknown as Promise<Response>;
      // Observe immediately in case post-commit durability/current checks fail.
      void pending.catch(() => {});
    }));
  } catch (error) {
    controller.abort();
    if (activeSends.get(step.id) === senderId) activeSends.delete(step.id);
    await settle(step, claimed ? senderId : undefined,
      pending ? 'unknown' : abortSignal.aborted ? 'aborted' : 'rejected', { physicalSend: Boolean(pending) });
    if (pending) void pending.then(response => response.body?.cancel()).catch(() => {});
    throw safeFailure(pending ? 'original_owner_model_outcome_unknown'
      : error instanceof OriginalOwnerError ? error.code : 'original_owner_model_refused');
  }
  if (!pending) throw safeFailure('original_owner_model_outcome_unknown');

  // These callbacks are created OUTSIDE both lock scopes, so their async-local
  // context cannot retain a released book or Persona-lock capability.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let terminal = false;
  const lifecycle: { reader?: ReadableStreamDefaultReader<Uint8Array>; receipt?: Receipt; status?: number } = {};
  let rejectInterrupted!: (error: OriginalOwnerError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  void interrupted.catch(() => {});
  const cleanup = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    abortSignal.removeEventListener('abort', onAbort);
    if (activeSends.get(step.id) === senderId) activeSends.delete(step.id);
  };
  const fail = async (code: string) => {
    if (terminal) return;
    terminal = true; controller.abort(); cleanup();
    if (lifecycle.reader) void lifecycle.reader.cancel().catch(() => {});
    try { await settle(step, senderId, 'unknown', { status: lifecycle.status, usage: lifecycle.receipt?.usage }); }
    finally { rejectInterrupted(safeFailure(code)); }
  };
  const onAbort = () => { void fail('original_owner_model_outcome_unknown').catch(() => {}); };
  const check = async () => {
    if (stopped) return;
    try {
      await step.authority.assertCurrent();
      await currentRecords(await readOriginalOwnerBook(), step.authority, step.model);
    } catch { await fail('original_owner_model_revoked'); return; }
  };
  const observe = async () => {
    await check();
    if (!stopped) { timer = setTimeout(() => { void observe().catch(() => {}); }, RECHECK_MS); timer.unref?.(); }
  };
  abortSignal.addEventListener('abort', onAbort, { once: true });
  if (abortSignal.aborted) onAbort();
  void observe().catch(() => {});
  let response: Response;
  try { response = await Promise.race([pending, interrupted]); }
  catch {
    await fail('original_owner_model_outcome_unknown').catch(() => {});
    cleanup();
    void pending.then(value => value.body?.cancel()).catch(() => {});
    throw safeFailure('original_owner_model_outcome_unknown');
  }
  lifecycle.status = response.status;
  // Derive the SDK content type from the admitted operation. Provider response
  // headers (including request ids) may reflect private request material.
  const responseHeaders = new Headers({ 'content-type': request.operation.endsWith('(stream)') ? 'text/event-stream' : 'application/json' });
  if (!response.ok) {
    terminal = true; cleanup();
    await settle(step, senderId, [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status) ? 'rejected' : 'unknown',
      { status: response.status });
    controller.abort(); await response.body?.cancel().catch(() => {});
    // Provider error text can contain reflected request headers or credentials.
    responseHeaders.set('content-type', 'application/json');
    return new Response(response.status === 304 ? null : JSON.stringify({ error: { message: 'Owner provider rejected the model request.', code: 'original_owner_provider_rejected' } }),
      { status: response.status, headers: responseHeaders });
  }
  if (!response.body) {
    await fail('original_owner_model_outcome_unknown').catch(() => {});
    throw safeFailure('original_owner_model_outcome_unknown');
  }
  const reader = lifecycle.reader = response.body.getReader();
  const receipt = lifecycle.receipt = new Receipt(request.operation.endsWith('(stream)'), wire.choices);
  const finish = async (state: 'completed' | 'rejected' | 'unknown') => {
    await Promise.race([check(), interrupted]);
    if (terminal) throw safeFailure('original_owner_model_outcome_unknown');
    await settle(step, senderId, state, { status: response.status, usage: receipt.usage });
    if (terminal || abortSignal.aborted) throw safeFailure('original_owner_model_outcome_unknown');
    terminal = true; cleanup();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        await Promise.race([check(), interrupted]);
        const chunk = await Promise.race([reader.read(), interrupted]);
        if (chunk.done) {
          const state = receipt.finish();
          await finish(state);
          reader.releaseLock();
          if (state === 'completed') output.close();
          else output.error(safeFailure(state === 'rejected' ? 'original_owner_provider_rejected' : 'original_owner_model_outcome_unknown'));
        } else {
          receipt.add(chunk.value);
          if (receipt.hasError) {
            await finish(receipt.errorState); controller.abort();
            void reader.cancel().catch(() => {});
            output.error(safeFailure('original_owner_provider_rejected'));
          } else if (receipt.completedSentinel) {
            await finish('completed');
            output.enqueue(chunk.value); output.close();
            void reader.cancel().then(() => reader.releaseLock()).catch(() => {});
          } else output.enqueue(chunk.value);
        }
      } catch {
        await fail('original_owner_model_outcome_unknown').catch(() => {});
        cleanup(); output.error(safeFailure('original_owner_model_outcome_unknown'));
      }
    },
    async cancel() {
      await fail('original_owner_model_outcome_unknown').catch(() => {});
      cleanup(); await reader.cancel().catch(() => {});
    },
  });
  return new Response(body, { status: response.status, headers: responseHeaders });
}
