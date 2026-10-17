import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createOriginalOwnerNativeParent } from './nativeParent';
import { NativeAccountProfileSchema } from './types';

/** Select this trusted producer with FLUJO_NATIVE_PARENT_MODULE at build and
 * startup. All values are server-only; no saved model/Flow can select them. */
function configuration() {
  const filename = process.env.FLUJO_NATIVE_CODEX_PROFILE;
  const sourceOrigin = process.env.FLUJO_NATIVE_SOURCE_ORIGIN;
  const toolOrigin = process.env.FLUJO_NATIVE_TOOL_ORIGIN;
  if (!filename || !path.isAbsolute(filename) || !sourceOrigin || !toolOrigin) {
    throw new Error('Native Parent requires its private profile and two loopback origins.');
  }
  const descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > 64 * 1024) throw new Error('Invalid Native Parent profile.');
    const profile = NativeAccountProfileSchema.parse(JSON.parse(readFileSync(descriptor,'utf8')));
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Native Parent profile changed.');
    return { sourceOrigin, toolOrigin, codexProfile: profile };
  } finally { closeSync(descriptor); }
}

export const nativeSourceParent = createOriginalOwnerNativeParent(configuration());
