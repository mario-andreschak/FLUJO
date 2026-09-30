import { randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { z } from 'zod';
import { runWithWorkspace } from '@/utils/workspace';
import { flowService } from '@/backend/services/flow';
import { createFlowExecutionSnapshot } from '@/backend/services/flow/executionSnapshot';
import { mcpService } from '@/backend/services/mcp';
import { createExecutionExtensionContext, type ExecutionExtensionAdapter } from '@/backend/execution/extensions';
import { bankingAdmission, createBankingRunContext, bindBankingRun,
  grantBankingActionTool, clearBankingActionGrant, type BankingPrincipal,
  type BankingRunContext } from './authority';
import { withBankingAdmission } from './admission';
import { assertBankingGraph } from './graph';
import { BankingError, bankingErrorResponse } from './errors';
import { conversationPattern } from './store';
import { bankingHandoffSchema, bankingReceiptSchema, bankingUnansweredQuestions } from './protocol';

const handle = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);
const common = { conversationId: z.string().regex(conversationPattern) };
export const actionBody = z.discriminatedUnion('operation', [
  z.object({ ...common, operation: z.literal('prepare'), transactionId: z.string().min(1).max(128),
    snapshot: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/), requestId: z.string().uuid() }).strict(),
  z.object({ ...common, operation: z.literal('confirm'), pendingHandle: handle,
    confirmed: z.literal(true) }).strict(),
  z.object({ ...common, operation: z.literal('receipt'), pendingHandle: handle }).strict(),
  z.object({ ...common, operation: z.literal('handoff'), reason: z.enum(['missing_evidence',
    'out_of_policy', 'emergency', 'action_unverified', 'customer_request', 'clarification_exhausted',
    'high_risk', 'duplicate_review', 'no_match_exhausted', 'tool_failure']),
    pendingHandle: handle.optional(), requestId: z.string().uuid().optional(),
    unanswered_questions: bankingUnansweredQuestions.default([]) }).strict(),
  z.object({ ...common, operation: z.literal('handoff_read'),
    handoffId: z.string().regex(/^HOF-[A-Za-z0-9_-]{8}$/) }).strict(),
]);
export type ActionBody = z.infer<typeof actionBody>;

const noCache = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache',
  Vary: 'Authorization, X-Flujo-User-Assertion' };

function codeStatus(code: string): number {
  if (code === 'authorization_denied' || code === 'authorization_required') return 401;
  if (code === 'reference_unavailable') return 404;
  if (['snapshot_changed', 'handoff_required', 'confirmation_required'].includes(code)) return 409;
  if (code === 'invalid_arguments') return 400;
  return 503;
}

export async function bankingActionPrincipal(principal: BankingPrincipal, body: ActionBody,
  signal: AbortSignal, adapter: ExecutionExtensionAdapter): Promise<Response> {
  try {
    const { policy, store, identity } = bankingAdmission(principal);
    return await runWithWorkspace(policy.workspace, async () => {
      await store.assertOwner(body.conversationId, identity);
      const flow = await flowService.getFlow(policy.flowId);
      if (!flow) throw new BankingError('approved_banking_graph_unavailable', 503);
      assertBankingGraph(createFlowExecutionSnapshot(policy.workspace, flow).flow, policy);
      return await withBankingAdmission(principal, { conversationId: body.conversationId,
        existingOwner: true, signal }, async job => {
        const rawContext = await createBankingRunContext(job, body.conversationId);
        await bindBankingRun(rawContext, body.conversationId, randomUUID());
        const context = createExecutionExtensionContext(adapter, rawContext);
        const invoke = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
          await grantBankingActionTool(rawContext, tool, args);
          try {
            const result = await mcpService.callTool(policy.bankServerName, tool, args, 30,
              undefined, undefined, signal, 'host', undefined, undefined, context);
            if (!result.success) throw new BankingError('banking_action_unavailable', 503);
            const wrapper = result.data as { structuredContent?: unknown; isError?: boolean };
            const data = wrapper?.structuredContent;
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
              throw new BankingError('banking_protocol_result_rejected', 502);
            }
            if (wrapper.isError) {
              const code = (data as { error?: unknown }).error;
              if (typeof code !== 'string') throw new BankingError('banking_protocol_result_rejected', 502);
              throw new BankingError(code, codeStatus(code));
            }
            return data as Record<string, unknown>;
          } finally { clearBankingActionGrant(rawContext); }
        };
        const verifiedHandoff = async (reason: string, pendingHandle?: string, requestId?: string,
          unansweredQuestions?: string[], expectedTransaction?: unknown) => {
          const args = { reason, ...(pendingHandle ? { pending_handle: pendingHandle } : {}),
            ...(requestId ? { request_id: requestId } : {}),
            unanswered_questions: unansweredQuestions ?? [] };
          try {
            const created = await invoke('create_verified_handoff', args);
            if (created.state !== 'created') throw new BankingError('banking_protocol_result_rejected', 502);
            const handoff = bankingHandoffSchema.parse(created.handoff);
            const read = await invoke('read_verified_handoff', { handoff_id: handoff.id });
            if (read.state !== 'created') throw new BankingError('banking_protocol_result_rejected', 502);
            const readback = bankingHandoffSchema.parse(read.handoff);
            // Currentness is observed again at read time; the persisted packet
            // and its historical provenance must remain identical.
            if (canonicalize({ ...handoff, transaction_currentness: readback.transaction_currentness }) !== canonicalize(readback)
                || readback.reason !== reason
                || canonicalize(readback.packet.unanswered_questions) !== canonicalize(unansweredQuestions ?? [])
                || Boolean(pendingHandle) !== (readback.packet.transaction !== null)
                || expectedTransaction !== undefined
                  && canonicalize(readback.packet.transaction) !== canonicalize(expectedTransaction)) {
              throw new BankingError('banking_protocol_result_rejected', 502);
            }
            return { state: 'handoff_verified', handoff: readback };
          } catch { return { state: 'handoff_unverified', reason }; }
        };
        let outcome: Record<string, unknown>;
        if (body.operation === 'prepare') {
          const prepared = await invoke('prepare_unrecognized_charge',
            { transaction_id: body.transactionId, snapshot: body.snapshot, request_id: body.requestId });
          const publicPrepared = { pending_handle: prepared.pending_handle, snapshot: prepared.snapshot,
            action: prepared.action, decision: prepared.decision, reason: prepared.reason,
            transaction: prepared.transaction };
          if (prepared.decision === 'existing_case') {
            // The prepare projection cannot establish the final claim. Read the
            // persisted receipt by the same pending identity without confirming.
            try {
              const existing = prepared.existing_case as { state?: unknown; receipt?: unknown } | undefined;
              if (existing?.state !== 'verified') throw new BankingError('banking_protocol_result_rejected', 502);
              const expected = bankingReceiptSchema.parse(existing.receipt);
              const read = await invoke('read_intake_receipt', { pending_handle: prepared.pending_handle });
              const receipt = bankingReceiptSchema.parse(read.receipt);
              if (read.state !== 'created' || canonicalize(receipt) !== canonicalize(expected)
                  || canonicalize(receipt.transaction) !== canonicalize(prepared.transaction)) {
                throw new BankingError('banking_protocol_result_rejected', 502);
              }
              outcome = { ...publicPrepared, state: 'existing_case_verified', receipt };
            } catch { outcome = { ...publicPrepared, state: 'action_unverified' }; }
          } else {
            outcome = prepared.decision === 'handoff'
              ? { ...publicPrepared, ...await verifiedHandoff(String(prepared.reason),
                String(prepared.pending_handle), body.requestId, undefined, prepared.transaction) }
              : { ...publicPrepared, state: 'pending_confirmation' };
          }
        } else if (body.operation === 'confirm') {
          try {
            await invoke('confirm_simulated_intake',
              { pending_handle: body.pendingHandle, confirmed: true });
          } catch (error) {
            // A timeout can occur after commit. Read by the same pending identity;
            // never replay the write to discover whether it happened.
            if (error instanceof BankingError && ['authorization_denied', 'reference_unavailable'].includes(error.code)) throw error;
            if (error instanceof BankingError && ['handoff_required', 'risk_data_unavailable', 'snapshot_changed'].includes(error.code)) {
              outcome = await verifiedHandoff(error.code === 'handoff_required' ? 'high_risk'
                : 'missing_evidence', body.pendingHandle);
              return Response.json(outcome, { headers: noCache });
            }
          }
          let read: Record<string, unknown> | undefined;
          try { read = await invoke('read_intake_receipt', { pending_handle: body.pendingHandle }); }
          catch { /* The write may have committed; do not replay it. */ }
          outcome = read?.state === 'created' ? { state: 'intake_verified', receipt: read.receipt }
            : { state: 'action_unverified',
              handoff: await verifiedHandoff('action_unverified', body.pendingHandle) };
        } else if (body.operation === 'receipt') {
          const read = await invoke('read_intake_receipt', { pending_handle: body.pendingHandle });
          outcome = read.state === 'created' ? { state: 'intake_verified', receipt: read.receipt }
            : { state: 'action_unverified' };
        } else if (body.operation === 'handoff') {
          if (!body.pendingHandle && !body.requestId) throw new BankingError('invalid_arguments', 400);
          outcome = await verifiedHandoff(body.reason, body.pendingHandle, body.requestId, body.unanswered_questions);
        } else {
          const read = await invoke('read_verified_handoff', { handoff_id: body.handoffId });
          const handoff = bankingHandoffSchema.safeParse(read.handoff);
          if (read.state !== 'created' || !handoff.success || handoff.data.id !== body.handoffId) {
            throw new BankingError('banking_protocol_result_rejected', 502);
          }
          outcome = { state: 'handoff_verified', handoff: handoff.data };
        }
        return Response.json(outcome, { headers: noCache });
      });
    });
  } catch (error) { return bankingErrorResponse(error); }
}
