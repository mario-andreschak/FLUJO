// Publishes the native Original session of one archived SDK dispatch, checking every saved copy.
import { nativeDigest, type NativeBrokerAuthority } from './nativeToolBroker';
import { NativeInvocationHeldError, type NativeInvocationReceipt } from './nativeToolJournal';
import { readNativeOriginLineage } from './nativeOriginLineage';
import {
  createNativeInvocationSession,
  type NativeInvocationSessionHook,
  type NativeInvocationSessionPayload,
} from './nativeInvocationSession';
import { readNativeSessionPayload, saveNativeSessionPayload } from './nativeSessionPayload';
import { assertNativeArchiveFormat, readSavedNativeOrigin, saveNativeSessionOrigin } from './nativeSavedOrigin';
import type { SdkRequestSnapshot } from '@/backend/services/model/adapters/types';
import { archiveModelDispatch, readNativeModelTurnSnapshot } from '@/backend/execution/flow/modelTurnArchive';

/** One native Original dispatch whose SDK request was just archived and submitted. */
export type NativeOriginalPublication = {
  receipt: NativeInvocationReceipt;
  entry: Awaited<ReturnType<typeof archiveModelDispatch>>;
  snapshot: SdkRequestSnapshot;
  hook: NativeInvocationSessionHook;
  authority: NativeBrokerAuthority;
  inventory: (NativeInvocationSessionPayload['inventory'] & { digest: string }) | undefined;
  abortController: AbortController;
  cancelToolPort: () => void;
  /** Called as soon as the session exists, so the attempt can hold or settle it if a later step fails. */
  onSessionCreated: (session: ReturnType<typeof createNativeInvocationSession>) => void;
};

/**
 * Publishes the native Original session for one dispatch: verifies the
 * archived request against the receipt and inventory, saves and re-reads the
 * session payload and origin, publishes the session through the host hook
 * and checks its lineage again. Any mismatch holds the invocation.
 */
export async function publishNativeOriginalSession(publication: NativeOriginalPublication): Promise<void> {
  const { receipt, entry, snapshot, hook, authority, inventory, abortController, cancelToolPort, onSessionCreated } = publication;
  const archived = await readNativeModelTurnSnapshot(receipt.owner.conversationId,
    entry.id, hook.root.workspace, abortController.signal);
  if (archived) assertNativeArchiveFormat(archived, entry.archiveVersion);
  if (!archived || archived.entry.outcome !== 'running' || archived.entry.id !== receipt.invocationId
    || archived.entry.conversationId !== receipt.owner.conversationId
    || archived.entry.runId !== receipt.owner.runId
    || archived.entry.node.nodeId !== receipt.owner.nodeId
    || archived.entry.modelId !== receipt.owner.modelId
    || archived.entry.attempt !== receipt.owner.attemptOrdinal
    || archived.entry.adapter !== snapshot.adapter
    || archived.entry.operation !== snapshot.operation
    || !inventory || inventory.digest !== receipt.owner.inventoryDigest) {
    throw new NativeInvocationHeldError(receipt.invocationId);
  }
  const lineage = await readNativeOriginLineage({
    receipt, authority,
    root: hook.root, signal: abortController.signal,
  });
  const payloadRef = await saveNativeSessionPayload({
    invocationId: receipt.invocationId,
    archive: { sdkRequest: archived.sdkRequest, genericWire: archived.genericWire,
      media: archived.media },
    inventory: { tools: inventory.tools, bindings: inventory.bindings,
        ...(inventory.terminationProtocol ? { terminationProtocol: inventory.terminationProtocol } : {}),
      syntheticNames: inventory.syntheticNames },
  });
  const savedPayload = await readNativeSessionPayload(payloadRef);
  if (savedPayload.invocationId !== receipt.invocationId
    || nativeDigest(savedPayload.archive.sdkRequest) !== nativeDigest(archived.sdkRequest)
    || nativeDigest(savedPayload.archive.genericWire) !== nativeDigest(archived.genericWire)
    || nativeDigest(savedPayload.archive.media) !== nativeDigest(archived.media)
    || nativeDigest(savedPayload.inventory.tools) !== nativeDigest(inventory.tools)
    || nativeDigest(savedPayload.inventory.bindings) !== nativeDigest(inventory.bindings)
    || nativeDigest(savedPayload.inventory.syntheticNames) !== nativeDigest(inventory.syntheticNames)) {
    throw new NativeInvocationHeldError(receipt.invocationId);
  }
  const nativeSession = createNativeInvocationSession({
    receipt: receipt, lineage,
    archive: {
      dispatchId: entry.id, adapter: archived.entry.adapter,
        archiveVersion: archived.version,
      operation: archived.entry.operation,
      sanitizedSdkRequestDigest: nativeDigest(archived.sdkRequest),
      sanitizedGenericWireDigest: nativeDigest(archived.genericWire),
      mediaCount: archived.media.length,
    },
      inventory: { digest: inventory.digest, toolCount: inventory.tools.length,
        ...(inventory.terminationProtocol ? { terminationProtocol: inventory.terminationProtocol } : {}) },
    payloadRef,
  }, abortController.signal, () => {
    abortController.abort();
    cancelToolPort();
  });
  onSessionCreated(nativeSession);
  await saveNativeSessionOrigin(nativeSession.session.descriptor);
  const savedOrigin = await readSavedNativeOrigin({ invocationId: receipt.invocationId,
    authority: authority, root: hook.root,
    signal: abortController.signal });
  if (nativeDigest(savedOrigin) !== nativeDigest(nativeSession.session.descriptor)) {
    throw new NativeInvocationHeldError(receipt.invocationId);
  }
  await hook.publish(nativeSession.session);
  abortController.signal.throwIfAborted();
  const publishedLineage = await readNativeOriginLineage({
    receipt, authority,
    root: hook.root, signal: abortController.signal,
  });
  if (publishedLineage.digest !== lineage.digest) {
    throw new NativeInvocationHeldError(receipt.invocationId);
  }
  nativeSession.emit('issue-uncertain');
  // A synchronous subscriber can cancel this very session.
  abortController.signal.throwIfAborted();
  await authority.assertCurrent();
  await hook.root.assertCurrent();
  await authority.assertCurrent();
  abortController.signal.throwIfAborted();
}
