import applicationPackage from '../../../../package.json';
import { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';

/** Change the protocol when the worker control/restore contract becomes incompatible. */
export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_SNAPSHOT_FORMAT_VERSION = 2;

export interface WorkerCompatibility {
  applicationVersion: string;
  snapshotFormatVersion: typeof WORKER_SNAPSHOT_FORMAT_VERSION;
  layoutVersion: typeof WORKSPACE_LAYOUT_VERSION;
  workerProtocolVersion: typeof WORKER_PROTOCOL_VERSION;
  revision?: string;
}

export function getWorkerCompatibility(): WorkerCompatibility {
  // Official images bake this value into their build environment. Do not infer
  // an application's compiled revision from its current git checkout: it may
  // be dirty, switched after building, or absent in an npm installation.
  const revision = process.env.FLUJO_BUILD_REVISION;
  return {
    applicationVersion: applicationPackage.version,
    snapshotFormatVersion: WORKER_SNAPSHOT_FORMAT_VERSION,
    layoutVersion: WORKSPACE_LAYOUT_VERSION,
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    ...(/^[a-f0-9]{40}$/.test(revision ?? '') ? { revision } : {}),
  };
}
