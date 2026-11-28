import type { FlujoChatMessage } from '@/shared/types/chat';

/**
 * Deterministic first stage of user-instruction retention (#1091).
 *
 * When old user turns no longer fit, the summarizer model picks which ones to
 * keep word for word. A model can miss a prohibition or a later correction, and
 * the Compaction Cliff study (arXiv 2608.22752) measured exactly that loss over
 * repeated rounds. Its Knowledge Triage cascade runs cheap surface rules before
 * a model and keeps every constraint verbatim. FLUJO follows that order: these
 * rules mark turns that must stay, and the model selection can only add more.
 *
 * The rules lean towards recall for corrections, negations and permission
 * changes. A false positive keeps one extra original turn; a miss could let the
 * assistant act against a user's prohibition. Plain requests stay unmarked so
 * long chats keep enough room for the summary.
 */
export type StandingInstructionKind = 'correction' | 'prohibition' | 'permission' | 'requirement';

const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}_])';
const APOSTROPHE = "['’]";

const phrases = (list: readonly string[]) =>
  new RegExp(NOT_WORD_BEFORE + '(?:' + list.join('|') + ')' + NOT_WORD_AFTER, 'iu');

const RULES: ReadonlyArray<readonly [StandingInstructionKind, RegExp]> = [
  ['correction', phrases([
    'actually', 'correction', 'correct(?:ed)? that', 'instead', 'i meant?', 'scratch that',
    'ignore (?:that|my|the previous|what i)', 'change of plans?',
    'corrijo', 'corrección', 'correccion', 'en realidad', 'en vez de', 'en lugar de', 'me equivoqu[eé]',
    'cambio de planes?',
    'korrektur', 'korrigier\\p{L}*', 'eigentlich', 'stattdessen', 'sondern',
    'plutôt', 'au lieu de', 'en fait', 'na verdade', 'em vez de', 'ao invés de', 'corrigindo',
    'invece', 'correzione', 'in realtà',
  ])],
  ['prohibition', phrases([
    'no', 'not allowed', 'not permitted', 'do not', 'don' + APOSTROPHE + '?t', 'never', 'must not',
    'mustn' + APOSTROPHE + '?t', 'should not', 'shouldn' + APOSTROPHE + '?t', 'may not', 'no longer', 'stop',
    'avoid', 'refrain', 'forbid(?:den)?', 'prohibit(?:ed)?', 'under no circumstances',
    'without (?:asking|approval|permission)',
    'nunca', 'jamás', 'jamas', 'prohibid[oa]s?', 'evita\\p{L}*', 'deja de', 'sin (?:permiso|preguntar)',
    'nicht', 'nie', 'niemals', 'kein(?:e|en|em|er|es)?', 'verboten', 'hör auf', 'unterlass\\p{L}*',
    'ne', 'n' + APOSTROPHE + '\\p{L}+', 'pas', 'jamais', 'interdit\\p{L}*', 'arrête',
    'não', 'nao', 'proibid[oa]s?', 'non', 'mai', 'vietat[oa]',
  ])],
  ['permission', phrases([
    'you (?:may|can)', 'allowed', 'permitted', 'permission', 'go ahead', 'approved?', 'authori[sz]\\p{L}*',
    'ok(?:ay)? to', 'feel free', 'revok\\p{L}*',
    'puedes', 'permitid[oa]s?', 'permiso', 'autoriz\\p{L}*', 'aprobad[oa]',
    'darfst', 'dürfen', 'darf', 'erlaubt?', 'erlaubnis', 'genehmig\\p{L}*', 'freigegeben',
    'tu peux', 'vous pouvez', 'autoris\\p{L}*', 'você pode', 'puoi', 'permesso',
  ])],
  ['requirement', phrases([
    'always', 'must', 'make sure', 'ensure', 'remember', 'from now on', 'going forward', 'only', 'except',
    'stick to', 'limit(?:ed)? to',
    'siempre', 'debes', 'asegúrate', 'asegurate', 'recuerda', 'a partir de ahora', 'solo', 'sólo',
    'únicamente', 'unicamente', 'excepto',
    'immer', 'muss', 'musst', 'müssen', 'achte darauf', 'denk daran', 'ab (?:jetzt|sofort)', 'nur',
    'ausschließlich', 'außer',
    'toujours', 'doit', 'dois', 'assure-toi', 'désormais', 'seulement', 'uniquement', 'sauf',
    'sempre', 'deve', 'devi', 'apenas', 'somente', 'exceto', 'soltanto', 'tranne',
  ])],
];

/** The text a user turn says, without its attachments. */
export function userText(message: FlujoChatMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
    ? part.text : '').join('\n');
}

/** The first matching kind for a user turn, or undefined for plain requests. */
export function classifyStandingInstruction(message: FlujoChatMessage): StandingInstructionKind | undefined {
  if (message.role !== 'user') return undefined;
  if (message.injected) return 'correction';
  const text = userText(message);
  if (!text) return undefined;
  return RULES.find(([, pattern]) => pattern.test(text))?.[0];
}

/** Original user turns that must stay verbatim on every summarized projection. */
export function requiredInstructionIds(messages: readonly FlujoChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.id && classifyStandingInstruction(message)) ids.add(message.id);
  }
  return ids;
}
