import { randomBytes, randomUUID } from 'node:crypto';
import { isTeamModel } from '@/shared/types/model/team';
import { z } from 'zod';
import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { readOwnerPolicy, ownerPolicyRevision } from '@/backend/services/security/ownerPolicy';
import { ownerHasScopes } from '@/backend/services/security/ownerCredentials';
import { modelService } from '@/backend/services/model';
import { encryptApiKey, resolveAndDecryptApiKey } from '@/backend/services/model/encryption';
import { resolveCompletionAdapterRoute } from '@/backend/services/model/adapters/completionRoute';
import { getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { getCurrentWorkspace } from '@/utils/workspace';
import { originalNativeAccountAttestation } from './nativeAccount';
import { mutateOriginalOwnerBook, flushOriginalOwnerBook, readOriginalOwnerBook } from './store';
import { ownerId, BudgetSchema, bytesDigest, ownerDigest, accountModelPlan, refuse,
  type OriginalOwnerAccount, type OriginalOwnerEnrollment } from './types';

const routing = z.partialRecord(z.enum(['openai-organization', 'openai-project', 'http-referer', 'x-title']),
  z.string().max(4096).refine(value => !/[\r\n\0]/.test(value)));
export const AccountInput = z.object({ modelId: ownerId, routingHeaders: routing }).strict();
export const EnrollmentInput = z.object({ personaId: ownerId, taskId: ownerId, accountId: ownerId,
  budget: BudgetSchema, allowedTools: z.array(z.enum(['worker_read_file','worker_write_file','worker_list_dir','worker_command'])),
  commands: z.array(z.string().min(1).max(16384)), directory: z.string().optional(),
}).strict();
function administration(request: Request) {
  const resolved = resolveOwnerRequest(request, ['control:admin', 'secrets:read'], { requireBearer: true });
  if (!resolved.ok) refuse('original_owner_administration_required');
  if (resolved.authorization.principal.workspaceId
    && resolved.authorization.principal.workspaceId !== getCurrentWorkspace()) refuse('original_owner_workspace_mismatch');
  return resolved.authorization;
}
function assertAdministrator(auth: ReturnType<typeof administration>) {
  if (auth.recheck()) refuse('original_owner_administrator_revoked');
}
export function assertOriginalApproval(approval: OriginalOwnerAccount['approval']): void {
  const filename = process.env.FLUJO_OWNER_AUTH_FILE;
  if (!filename) refuse('original_owner_policy_required');
  const policy = readOwnerPolicy(filename);
  const credential = policy.credentials.find(value => value.id === approval.credentialId);
  if (policy.ownerId !== approval.ownerId || ownerPolicyRevision(policy) !== approval.policyRevision
    || !credential || credential.revokedAt !== null || credential.expiresAt <= Date.now()
    || credential.issuedAt > Date.now()
    || (credential.workspaceId && credential.workspaceId !== getCurrentWorkspace())
    || !ownerHasScopes({ ownerId: policy.ownerId, credentialId: credential.id, scopes: credential.scopes },
      ['control:admin', 'secrets:read'])) refuse('original_owner_approval_revoked');
}
/** Transfer one actual configured model credential into the private owner account. */
export async function createOriginalOwnerAccount(request: Request, input: unknown) {
  const auth = administration(request), parsed = AccountInput.parse(input);
  // Catalog writers take the catalog lock before the owner journal. Model
  // dispatch already holds its read lease before claiming the owner step.
  return modelService.withOwnerCatalogUpdate(updateModel => mutateOriginalOwnerBook(async book => {
    assertAdministrator(auth);
    const model = await modelService.getModel(parsed.modelId);
    if (!model || model.fallbackPolicy || isTeamModel(model)) refuse('original_owner_model_unavailable');
    const native = model.adapter === 'codex-cli';
    if (!native && resolveCompletionAdapterRoute(model) !== 'openai') refuse('original_owner_adapter_unsupported');
    const approval = { ownerId: auth.principal.ownerId, credentialId: auth.principal.credentialId,
      policyRevision: auth.principal.policyRevision };
    const previous = book.accounts.find(value => value.modelId === model.id
      && value.ownerId === auth.principal.ownerId && value.state !== 'revoked');
    if (native) {
      if (Object.keys(parsed.routingHeaders).length) refuse('original_owner_native_routing_forbidden');
      const attestation = await originalNativeAccountAttestation(model);
      assertAdministrator(auth);
      if (previous) {
        if (previous.kind !== 'codex' || previous.modelDigest !== ownerDigest(accountModelPlan(model))
          || ownerDigest(previous.nativeProfile) !== ownerDigest(attestation.nativeProfile)
          || previous.nativeAccountScope !== attestation.nativeAccountScope) {
          refuse('original_owner_native_account_changed');
        }
        previous.approval = approval; previous.updatedAt = Date.now();
        return { id: previous.id, modelId: model.id, kind: previous.kind, state: previous.state };
      }
      const now = Date.now(), id = randomUUID();
      book.accounts.push({ id, ownerId: auth.principal.ownerId, modelId: model.id, kind: 'codex',
        modelDigest: ownerDigest(accountModelPlan(model)), credential: '', routingHeaders: {},
        ...attestation, state: 'active', approval, createdAt: now, updatedAt: now });
      return { id, modelId: model.id, kind: 'codex', state: 'active' };
    }
    if (previous) {
      const binding = { ownerId: previous.ownerId, credentialId: previous.id };
      const bound = { ...model, ApiKey: '', ownerCredentialBinding: binding };
      if (ownerDigest(accountModelPlan(bound)) !== previous.modelDigest
        || ownerDigest(parsed.routingHeaders) !== ownerDigest(previous.routingHeaders)) {
        refuse('original_owner_pending_account_changed');
      }
      if (model.ownerCredentialBinding) {
        if (model.ownerCredentialBinding.ownerId !== binding.ownerId
          || model.ownerCredentialBinding.credentialId !== binding.credentialId || model.ApiKey !== '') {
          refuse('original_owner_model_binding_changed');
        }
      } else {
        if (previous.state !== 'pending'
          || await resolveAndDecryptApiKey(model.ApiKey) !== await resolveAndDecryptApiKey(previous.credential)) {
          refuse('original_owner_pending_credential_changed');
        }
        assertAdministrator(auth);
        const saved = await updateModel(bound);
        if (!saved.success) refuse('original_owner_model_binding_failed');
      }
      assertAdministrator(auth);
      previous.approval = approval; previous.state = 'active'; previous.updatedAt = Date.now();
      return { id: previous.id, modelId: model.id, kind: previous.kind, state: previous.state };
    }
    if (model.ownerCredentialBinding) refuse('original_owner_model_unavailable');
    const key = await resolveAndDecryptApiKey(model.ApiKey);
    if (!key?.trim() || key.startsWith('${global:') || key.startsWith('encrypted:')) {
      refuse('original_owner_credential_unavailable');
    }
    const id = randomUUID(), now = Date.now();
    const bound = { ...model, ApiKey: '', ownerCredentialBinding: { ownerId: auth.principal.ownerId, credentialId: id } };
    const account: OriginalOwnerAccount = { id, ownerId: auth.principal.ownerId, modelId: model.id,
      kind: 'openai', modelDigest: ownerDigest(accountModelPlan(bound)),
      credential: await encryptApiKey(key), routingHeaders: parsed.routingHeaders,
      state: 'pending', approval, createdAt: now, updatedAt: now };
    book.accounts.push(account); await flushOriginalOwnerBook();
    assertAdministrator(auth);
    const result = await updateModel(bound);
    if (!result.success) refuse('original_owner_model_binding_failed');
    assertAdministrator(auth);
    const current = await modelService.getModel(model.id);
    if (!current || ownerDigest(accountModelPlan(current)) !== account.modelDigest
      || current.ApiKey !== '') refuse('original_owner_model_binding_changed');
    account.state = 'active'; account.updatedAt = Date.now();
    return { id, modelId: model.id, kind: account.kind, state: account.state };
  }));
}
export async function enrollOriginalOwnerTask(request: Request, input: unknown) {
  const auth = administration(request), parsed = EnrollmentInput.parse(input);
  return mutateOriginalOwnerBook(async book => {
    assertAdministrator(auth);
    const task = await getPersonaWorkItem(parsed.personaId, parsed.taskId);
    const account = book.accounts.find(value => value.id === parsed.accountId && value.state === 'active');
    if (!task || task.personaId !== parsed.personaId || (!task.goal && !task.parentGoalId)
      || ['completed','cancelled'].includes(task.status) || !account || account.ownerId !== auth.principal.ownerId) {
      refuse('original_owner_enrollment_refused');
    }
    assertOriginalApproval(account.approval);
    // The restricted CLI does not expose a hard output-token limit or an
    // owner-fenced per-inference counter. Never silently ignore a finite budget.
    if (account.kind === 'codex'
      && (parsed.budget.maxModelSteps !== null || parsed.budget.maxOutputTokens !== null)) {
      refuse('original_owner_native_budget_unsupported');
    }
    if (book.enrollments.some(value => value.state === 'active' && value.personaId === parsed.personaId
      && value.taskId === parsed.taskId)) refuse('original_owner_task_already_enrolled');
    const previousEnrollments = new Set(book.enrollments.filter(value => value.personaId === parsed.personaId
      && value.taskId === parsed.taskId).map(value => value.id));
    if (book.steps.some(step => previousEnrollments.has(step.enrollmentId)
      && ['sending', 'unknown'].includes(step.state))) refuse('original_owner_outcome_unresolved');
    if (parsed.allowedTools.length && !parsed.directory) refuse('original_owner_tool_directory_required');
    if (parsed.commands.length && !parsed.allowedTools.includes('worker_command')) refuse('original_owner_command_not_granted');
    const secret = randomBytes(32).toString('base64url'), now = Date.now();
    const enrollment: OriginalOwnerEnrollment = { ...parsed, id: randomUUID(), workspace: getCurrentWorkspace(),
      ownerId: auth.principal.ownerId, modelId: account.modelId,
      workerAuthorizationDigest: bytesDigest(`Bearer ${secret}`), state: 'active',
      approval: { ownerId: auth.principal.ownerId, credentialId: auth.principal.credentialId,
        policyRevision: auth.principal.policyRevision }, createdAt: now, updatedAt: now };
    book.enrollments.push(enrollment); assertAdministrator(auth);
    return { id: enrollment.id, workerAuthorization: `Bearer ${secret}` };
  });
}
export async function revokeOriginalOwnerRecord(request: Request, id: string) {
  ownerId.parse(id); const auth = administration(request);
  return mutateOriginalOwnerBook(async book => {
    assertAdministrator(auth);
    const value = book.enrollments.find(item => item.id === id) ?? book.accounts.find(item => item.id === id);
    if (!value || value.ownerId !== auth.principal.ownerId) refuse('original_owner_record_not_found');
    value.state = 'revoked'; value.updatedAt = Date.now(); return { id, state: value.state };
  });
}
export async function listOriginalOwnerRecords(request: Request) {
  const auth = administration(request), book = await readOriginalOwnerBook(); assertAdministrator(auth);
  return { accounts: book.accounts.filter(value => value.ownerId === auth.principal.ownerId)
    .map(({id, modelId, kind, state}) => ({id, modelId, kind, state})),
  enrollments: book.enrollments.filter(value => value.ownerId === auth.principal.ownerId)
    .map(({id, personaId, taskId, modelId, state, budget}) => ({id, personaId, taskId, modelId, state, budget})),
  steps: book.steps.filter(value => book.enrollments.some(enrollment => enrollment.id === value.enrollmentId
    && enrollment.ownerId === auth.principal.ownerId))
    .map(({id, enrollmentId, kind, state, status, usage}) => ({id, enrollmentId, kind, state, status, usage})) };
}
