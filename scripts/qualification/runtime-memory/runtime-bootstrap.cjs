'use strict';
const assert = require('node:assert/strict');
const { sourceManifestHash } = require('./profile.cjs');
const { ownedProviderConfig } = require('./provider-control.cjs');
const MAX_CHANNEL_BYTES = 4096;

async function establishRuntimeIdentity(loader, guard, contract) {
  assert(!process.env.FLUJO_569_PROVIDER_TOKEN, 'Bootstrap must not inherit a provider credential');
  assert(/^[a-f0-9]{48}$/.test(contract.bootstrapNonce), 'Invalid bootstrap nonce');
  let identity, failure;
  try {
    const locks = loader.load('backend/services/enduringAgents/runtimeLock.ts');
    await locks.initializePersonaRuntimeLockProcessIdentity();
    identity = await locks.getRuntimeProcessIdentity();
    assert.equal(identity.pid, process.pid);
  } catch (error) { failure = error; }
  const settlement = await guard.sealBootstrap();
  if (failure) throw failure;
  const source = loader.verify();
  return { version: 'runtime-bootstrap-v1', nonce: contract.bootstrapNonce, pid: process.pid, identity, settlement,
    sourceHead: contract.sourceHead, harnessSha256: contract.harnessSha256, profileSha256: contract.profileSha256,
    source, sourceManifestSha256: sourceManifestHash(source) };
}
function readParentConfiguration(stream, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(MAX_CHANNEL_BYTES); let length = 0, finished = false;
    const done = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      stream.removeListener('data', data); stream.removeListener('end', end); stream.removeListener('error', failed);
      if (error) { stream.destroy(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_CHANNEL_BYTES - length) {
        done(new Error('Parent bootstrap channel exceeds allowance')); return;
      }
      bytes.set(chunk, length); length += chunk.byteLength;
    };
    const end = () => {
      try { done(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))); }
      catch { done(new Error('Malformed parent bootstrap configuration')); }
    };
    const failed = () => done(new Error('Parent bootstrap channel failed'));
    const timer = setTimeout(() => done(new Error('Parent bootstrap channel timed out')), timeoutMs);
    stream.on('data', data); stream.once('end', end); stream.once('error', failed);
  });
}
function providerFromParent(message, contract, ready) {
  assert(['pilot', 'endurance'].includes(contract.mode), 'Provider configuration requires a qualification mode');
  assert(message && Object.getPrototypeOf(message) === Object.prototype);
  assert.deepEqual(Object.keys(message).sort(), ['harnessSha256', 'nonce', 'pid', 'profileSha256', 'provider', 'sourceHead', 'version']);
  assert.equal(message.version, 'runtime-provider-v1');
  assert.equal(message.nonce, contract.bootstrapNonce); assert.equal(message.pid, process.pid);
  for (const field of ['sourceHead', 'harnessSha256', 'profileSha256']) assert.equal(message[field], contract[field]);
  assert(message.provider && Object.getPrototypeOf(message.provider) === Object.prototype);
  assert.deepEqual(Object.keys(message.provider).sort(), ['pid', 'port', 'token']);
  assert(Number.isSafeInteger(message.provider.pid) && message.provider.pid > 0);
  assert(Number.isSafeInteger(message.provider.port) && message.provider.port > 0 && message.provider.port <= 65535);
  return ownedProviderConfig(contract, ready, { FLUJO_569_PROVIDER_TOKEN: message.provider.token,
    FLUJO_569_PROVIDER_PID: String(message.provider.pid), FLUJO_569_PROVIDER_PORT: String(message.provider.port) });
}
function equipmentFromParent(message, contract) {
  assert.equal(contract.mode, 'equipment-bootstrap'); assert.equal(contract.equipmentOnly, true); assert.equal(contract.qualification, false);
  assert.deepEqual(Object.keys(message).sort(), ['harnessSha256', 'nonce', 'peer', 'pid', 'profileSha256', 'sourceHead', 'version']);
  assert.equal(message.version, 'runtime-equipment-v1'); assert.equal(message.nonce, contract.bootstrapNonce); assert.equal(message.pid, process.pid);
  for (const field of ['sourceHead', 'harnessSha256', 'profileSha256']) assert.equal(message[field], contract[field]);
  assert.deepEqual(Object.keys(message.peer), ['pid']); assert(Number.isSafeInteger(message.peer.pid) && message.peer.pid > 0);
}
module.exports = { establishRuntimeIdentity, readParentConfiguration, providerFromParent, equipmentFromParent };
