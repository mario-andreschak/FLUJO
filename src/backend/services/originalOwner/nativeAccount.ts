import path from 'node:path';
import type { Model } from '@/shared/types/model';
import { assertRestrictedCodexProfile, type RestrictedCodexProfile } from '@/backend/services/model/adapters/codexRestrictedProfile';
import { codexSessionAccountScope } from '@/backend/services/model/adapters/codexSessionStore';
import { NativeAccountProfileSchema, ownerDigest, refuse, type OriginalOwnerAccount } from './types';

const root = globalThis as typeof globalThis & { __flujoOriginalNativeProfile?: Readonly<RestrictedCodexProfile> };

/** Trusted server composition only. Neither enrollment nor a Flow selects a CLI. */
export function installOriginalNativeProfile(profile: RestrictedCodexProfile): void {
  const checked = NativeAccountProfileSchema.parse(profile);
  if (!path.isAbsolute(checked.verifiedCliPath) || !path.isAbsolute(checked.verifiedModelCatalogPath)) {
    refuse('original_owner_native_profile_required');
  }
  if (root.__flujoOriginalNativeProfile && ownerDigest(root.__flujoOriginalNativeProfile) !== ownerDigest(checked)) {
    refuse('original_owner_native_profile_changed');
  }
  root.__flujoOriginalNativeProfile ??= Object.freeze(checked);
}

function nativeProfileFor(model: Model) {
  const profile = root.__flujoOriginalNativeProfile;
  if (!profile || model.adapter !== 'codex-cli' || !['gpt-6-luna', 'gpt-6-sol'].includes(model.name)
    || model.ApiKey !== '' || model.ownerCredentialBinding || model.fallbackPolicy) {
    refuse('original_owner_native_account_not_qualified');
  }
  return profile;
}

export async function originalNativeAccountAttestation(model: Model) {
  const profile = nativeProfileFor(model);
  await assertRestrictedCodexProfile(profile, model.name);
  // This reader accepts file-backed ChatGPT login only. An API key, provider
  // endpoint or a claimed auth mode cannot supply this account identity.
  const nativeAccountScope = await codexSessionAccountScope();
  return { nativeProfile: NativeAccountProfileSchema.parse(profile), nativeAccountScope };
}

export async function assertOriginalNativeAccount(account: OriginalOwnerAccount, model: Model): Promise<void> {
  if (account.kind !== 'codex' || account.credential !== '') refuse('original_owner_native_account_changed');
  const current = { nativeProfile: nativeProfileFor(model), nativeAccountScope: await codexSessionAccountScope() };
  if (current.nativeAccountScope !== account.nativeAccountScope
    || ownerDigest(current.nativeProfile) !== ownerDigest(account.nativeProfile)) {
    refuse('original_owner_native_account_changed');
  }
}
