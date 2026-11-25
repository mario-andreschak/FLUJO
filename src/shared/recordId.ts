import { v4 as uuidv4 } from 'uuid';

/** Which ids a caller may choose for a new record, and how to say it. */
export interface RecordIdRule {
  readonly pattern: RegExp;
  readonly description: string;
}

/** Ids that are safe in an address such as `/api/model/{id}`. */
export const RECORD_ID_RULE: RecordIdRule = {
  pattern: /^[A-Za-z0-9._:-]{1,128}$/,
  description: '1 to 128 letters, digits, dots, underscores, colons or hyphens',
};

/** Ids that also become a file name (`db/<collection>/<id>.json`). */
export const FILE_RECORD_ID_RULE: RecordIdRule = {
  pattern: /^[A-Za-z0-9_-]{1,64}$/,
  description: '1 to 64 letters, digits, underscores or hyphens',
};

export type NewRecordId = { ok: true; id: string } | { ok: false; error: string };

/**
 * The id a new record is stored under. Every create path goes through here, so
 * no record is ever saved without an id: a request without one gets a fresh
 * UUID (the same kind the app makes), and a chosen id must follow the rule.
 * Whether the id is already taken is for the caller to check against its store.
 */
export function newRecordId(requested: unknown, rule: RecordIdRule = RECORD_ID_RULE): NewRecordId {
  if (requested === undefined || requested === null) return { ok: true, id: uuidv4() };
  if (typeof requested === 'string' && rule.pattern.test(requested) && requested !== '.' && requested !== '..') {
    return { ok: true, id: requested };
  }
  return {
    ok: false,
    error: `The id must be ${rule.description}. Leave it out and FLUJO makes one.`,
  };
}
