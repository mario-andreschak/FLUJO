import type { Translator } from '@/frontend/i18n/core';
import type { PublicRoleBehavior } from '@/shared/types/enduringAgent';

/** Recognize the platform's stored default copy without changing immutable Role data. */
export function localizeRoleBehavior(
  behavior: PublicRoleBehavior,
  t: Translator,
): PublicRoleBehavior {
  // Match the complete label pair, not just the reserved slot key: Role authors
  // can supply their own names and descriptions, which must remain verbatim.
  if (behavior.key === 'primary'
    && behavior.name === 'Primary'
    && behavior.description === 'Perform the Role’s assigned work using its immutable instructions.') {
    return { ...behavior, name: t('roles.behavior.primary.name'), description: t('roles.behavior.primary.description') };
  }
  if (behavior.key === 'maintain_memory'
    && behavior.name === 'Maintain memory'
    && behavior.description === 'Propose a bounded set of trustworthy, provenance-bearing memories after an Activity.') {
    return { ...behavior, name: t('roles.behavior.memory.name'), description: t('roles.behavior.memory.description') };
  }
  return behavior;
}
