/**
 * The Human step contract (issue #1095), shared by the builders, the compiler, the
 * runtime and the answer card. A Human step stops a run until a person answers:
 * a yes or no (`approval`), a few typed answers (`input`) or a changed copy of a
 * result (`edit`). See docs/architecture/human-step-node.md.
 *
 * Pure and dependency-light, so the browser and the server check answers the same way.
 */
import { isValidRunVarName } from './resolveRunVars';

/** The name of the pending call a waiting Human step shows. */
export const HUMAN_STEP_TOOL_NAME = 'human_step';
/** Conversation result of an approval, the same text a Static wait gives. */
export const HUMAN_STEP_APPROVED_RESULT = 'approved';
/** Conversation result of a no, the same fixed text a rejected tool call gets. */
export const HUMAN_STEP_REJECTED_RESULT = 'tool denied';
/** Conversation result when nobody answered in time. */
export const HUMAN_STEP_TIMED_OUT_RESULT = 'timed out';

export const HUMAN_STEP_MODES = ['approval', 'input', 'edit'] as const;
export type HumanStepMode = typeof HUMAN_STEP_MODES[number];

export const HUMAN_FIELD_TYPES = ['text', 'longText', 'number', 'integer', 'boolean', 'choice', 'multiChoice'] as const;
export type HumanFieldType = typeof HUMAN_FIELD_TYPES[number];

/** One typed question in an `input` step. Flat on purpose: it maps onto MCP form elicitation. */
export interface HumanField {
  name: string;
  label?: string;
  type: HumanFieldType;
  required?: boolean;
  /** `choice` and `multiChoice` only. */
  options?: string[];
  /** `number` and `integer` only. */
  min?: number;
  max?: number;
  /** `text` and `longText` only. */
  maxLength?: number;
}

/** Where the content to review comes from. */
export interface HumanReviewSource {
  /** The latest assistant message (the default), or a run variable. */
  source: 'last-assistant' | 'variable';
  variable?: string;
  /** `json` means an edited value must stay valid JSON. */
  format?: 'text' | 'json';
}

export type HumanNoChoice = 'stop' | 'continue';

export interface HumanStepProperties {
  name?: string;
  mode?: HumanStepMode;
  /** Short title for lists. Defaults to the node label. */
  title?: string;
  /** What the person is asked. Supports `${var:…}`. */
  prompt?: string;
  /** What the person sees and, in `edit` mode, changes. Defaults to the latest assistant message. */
  review?: HumanReviewSource;
  /** `input` mode questions. */
  fields?: HumanField[];
  /** Run variable that receives the result as JSON. Defaults to `review`. */
  outputVariable?: string;
  /** How long the step waits before it times out. Defaults to 7 days. */
  timeoutMinutes?: number;
  /** What a no does. `stop` (default) ends the run, `continue` lets the flow route on it. */
  onReject?: HumanNoChoice;
  /** What a time-out does. `stop` (default) ends the run, `continue` lets the flow route on it. */
  onTimeout?: HumanNoChoice;
  /** The run's final text after a no with `onReject: stop`. */
  rejectedText?: string;
  /** The run's final text after a time-out with `onTimeout: stop`. */
  timedOutText?: string;
}

export type HumanOutcome = 'approved' | 'rejected' | 'submitted' | 'declined' | 'timed_out';

export const DEFAULT_HUMAN_OUTPUT_VARIABLE = 'review';
export const DEFAULT_HUMAN_TIMEOUT_MINUTES = 7 * 24 * 60;
export const MIN_HUMAN_TIMEOUT_MINUTES = 1;
export const MAX_HUMAN_TIMEOUT_MINUTES = 365 * 24 * 60;
export const MAX_HUMAN_FIELDS = 20;
export const MAX_HUMAN_OPTIONS = 50;
/** Content to review and an edited value are bounded like a Static capture. */
export const MAX_HUMAN_TEXT_CHARS = 65_536;
export const DEFAULT_HUMAN_REJECTED_TEXT = 'Not approved.';
export const DEFAULT_HUMAN_TIMED_OUT_TEXT = 'Nobody answered in time.';

/** The waiting request as the person sees it. Its digest covers exactly these fields. */
export interface HumanTaskView {
  requestId: string;
  nodeId: string;
  mode: HumanStepMode;
  title: string;
  prompt: string;
  candidate?: string;
  format?: 'text' | 'json';
  fields?: HumanField[];
}

/** The payload of the pending `human_step` call: the view, its digest and its deadline. */
export interface HumanTaskCallArguments extends HumanTaskView {
  digest: string;
  expiresAt: string;
}

/** What an answer carries besides approve or reject. */
export interface HumanAnswer {
  /** The digest of what the person saw. Needed to accept. */
  digest?: string;
  /** The typed answers (`input`) or the changed text (`edit`). */
  value?: unknown;
  /** Same key, same answer: the saved receipt comes back instead of a second decision. */
  idempotencyKey?: string;
}

export function acceptOutcome(mode: HumanStepMode): HumanOutcome {
  return mode === 'approval' ? 'approved' : 'submitted';
}

export function declineOutcome(mode: HumanStepMode): HumanOutcome {
  return mode === 'approval' ? 'rejected' : 'declined';
}

export function isAcceptingOutcome(outcome: HumanOutcome): boolean {
  return outcome === 'approved' || outcome === 'submitted';
}

export interface HumanStepIssue {
  code: string;
  message: string;
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Check an authored Human step and return the issues a builder, the compiler and the
 * runtime all report. An empty list means the step can run.
 */
export function humanStepIssues(properties: HumanStepProperties | undefined | null): HumanStepIssue[] {
  const issues: HumanStepIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  const props = properties ?? {};
  const mode = props.mode ?? 'approval';
  if (!(HUMAN_STEP_MODES as readonly string[]).includes(mode)) {
    add('human-invalid-mode', 'A Human step asks for approval, input or an edit.');
    return issues;
  }
  if (typeof props.prompt !== 'string' || !props.prompt.trim()) {
    add('human-missing-prompt', 'Say what the person should decide or fill in.');
  }
  if (props.outputVariable !== undefined && !isValidRunVarName(props.outputVariable)) {
    add('human-invalid-output-variable', 'The result name starts with a letter or _, then letters, digits, _ or -.');
  }
  if (props.timeoutMinutes !== undefined && (!isFiniteNumber(props.timeoutMinutes)
    || props.timeoutMinutes < MIN_HUMAN_TIMEOUT_MINUTES || props.timeoutMinutes > MAX_HUMAN_TIMEOUT_MINUTES)) {
    add('human-invalid-timeout', `Wait between ${MIN_HUMAN_TIMEOUT_MINUTES} minute and ${MAX_HUMAN_TIMEOUT_MINUTES / (24 * 60)} days.`);
  }
  for (const [key, value] of [['onReject', props.onReject], ['onTimeout', props.onTimeout]] as const) {
    if (value !== undefined && value !== 'stop' && value !== 'continue') {
      add('human-invalid-choice', `${key} is stop or continue.`);
    }
  }
  const review = props.review;
  if (review !== undefined) {
    if (!review || (review.source !== 'last-assistant' && review.source !== 'variable')) {
      add('human-invalid-review', 'Review the latest assistant message or a run variable.');
    } else if (review.source === 'variable' && !isValidRunVarName(review.variable)) {
      add('human-invalid-review', 'Name the run variable to review.');
    }
    if (review?.format !== undefined && review.format !== 'text' && review.format !== 'json') {
      add('human-invalid-review', 'The review format is text or json.');
    }
  }
  if (mode === 'input') {
    const fields = props.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
      add('human-missing-fields', 'An input step needs at least one question.');
    } else {
      if (fields.length > MAX_HUMAN_FIELDS) add('human-too-many-fields', `Ask at most ${MAX_HUMAN_FIELDS} questions.`);
      const names = new Set<string>();
      for (const field of fields) {
        const label = typeof field?.name === 'string' ? field.name : '?';
        if (!field || !FIELD_NAME.test(field.name ?? '')) {
          add('human-invalid-field', `Question "${label}" needs a name made of letters, digits, _ or -.`);
          continue;
        }
        if (names.has(field.name)) add('human-invalid-field', `Two questions are called "${field.name}".`);
        names.add(field.name);
        if (!(HUMAN_FIELD_TYPES as readonly string[]).includes(field.type)) {
          add('human-invalid-field', `Question "${field.name}" has an unknown type.`);
          continue;
        }
        if (field.type === 'choice' || field.type === 'multiChoice') {
          const options = field.options;
          if (!Array.isArray(options) || options.length === 0 || options.length > MAX_HUMAN_OPTIONS
            || options.some((option) => typeof option !== 'string' || !option.trim())
            || new Set(options).size !== options.length) {
            add('human-invalid-field', `Question "${field.name}" needs 1 to ${MAX_HUMAN_OPTIONS} different choices.`);
          }
        }
        if ((field.min !== undefined && !isFiniteNumber(field.min)) || (field.max !== undefined && !isFiniteNumber(field.max))
          || (isFiniteNumber(field.min) && isFiniteNumber(field.max) && field.min > field.max)) {
          add('human-invalid-field', `Question "${field.name}" has a wrong lowest or highest value.`);
        }
        if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1
          || field.maxLength > MAX_HUMAN_TEXT_CHARS)) {
          add('human-invalid-field', `Question "${field.name}" has a wrong length limit.`);
        }
      }
    }
  }
  return issues;
}

export type HumanAnswerCheck =
  | { ok: true; value: unknown }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

function checkField(field: HumanField, raw: unknown): { value?: unknown; error?: string } {
  const empty = raw === undefined || raw === null || raw === ''
    || (Array.isArray(raw) && raw.length === 0);
  if (empty) return field.required ? { error: 'This answer is needed.' } : {};
  switch (field.type) {
    case 'text':
    case 'longText': {
      if (typeof raw !== 'string') return { error: 'Enter text.' };
      const limit = field.maxLength ?? MAX_HUMAN_TEXT_CHARS;
      return raw.length > limit ? { error: `Use at most ${limit} characters.` } : { value: raw };
    }
    case 'number':
    case 'integer': {
      const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (!isFiniteNumber(value)) return { error: 'Enter a number.' };
      if (field.type === 'integer' && !Number.isInteger(value)) return { error: 'Enter a whole number.' };
      if (isFiniteNumber(field.min) && value < field.min) return { error: `Enter ${field.min} or more.` };
      if (isFiniteNumber(field.max) && value > field.max) return { error: `Enter ${field.max} or less.` };
      return { value };
    }
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : { error: 'Choose yes or no.' };
    case 'choice':
      return typeof raw === 'string' && (field.options ?? []).includes(raw)
        ? { value: raw } : { error: 'Pick one of the choices.' };
    case 'multiChoice':
      return Array.isArray(raw) && raw.every((item) => typeof item === 'string' && (field.options ?? []).includes(item))
        && new Set(raw).size === raw.length
        ? { value: raw } : { error: 'Pick from the choices.' };
    default:
      return { error: 'This question has an unknown type.' };
  }
}

/**
 * Check an accepting answer against the request the person saw. Returns the clean
 * value to store: only known fields for `input`, the text for `edit`, nothing for
 * `approval`. Never throws.
 */
export function checkHumanAnswer(
  view: Pick<HumanTaskView, 'mode' | 'fields' | 'format' | 'candidate'>,
  value: unknown,
): HumanAnswerCheck {
  if (view.mode === 'approval') return { ok: true, value: undefined };
  if (view.mode === 'edit') {
    const text = value === undefined ? view.candidate ?? '' : value;
    if (typeof text !== 'string') return { ok: false, error: 'The changed text must be text.' };
    if (text.length > MAX_HUMAN_TEXT_CHARS) {
      return { ok: false, error: `The changed text is longer than ${MAX_HUMAN_TEXT_CHARS} characters.` };
    }
    if (view.format === 'json') {
      try { JSON.parse(text); } catch { return { ok: false, error: 'The changed text must stay valid JSON.' }; }
    }
    return { ok: true, value: text };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Send the answers as an object, one entry per question.' };
  }
  const answers = value as Record<string, unknown>;
  const fields = view.fields ?? [];
  const known = new Set(fields.map((field) => field.name));
  const unknown = Object.keys(answers).filter((key) => !known.has(key));
  if (unknown.length > 0) return { ok: false, error: `Unknown questions: ${unknown.join(', ')}.` };
  const clean: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  for (const field of fields) {
    const checked = checkField(field, Object.hasOwn(answers, field.name) ? answers[field.name] : undefined);
    if (checked.error) fieldErrors[field.name] = checked.error;
    else if (checked.value !== undefined) clean[field.name] = checked.value;
  }
  return Object.keys(fieldErrors).length > 0
    ? { ok: false, error: 'Some answers need a fix.', fieldErrors }
    : { ok: true, value: clean };
}

/** Read the payload of a pending `human_step` call, or undefined for any other call. */
export function parseHumanTaskCall(call: { function?: { name?: string; arguments?: string } } | null | undefined):
  HumanTaskCallArguments | undefined {
  if (call?.function?.name !== HUMAN_STEP_TOOL_NAME) return undefined;
  try {
    const parsed = JSON.parse(call.function.arguments ?? '') as Partial<HumanTaskCallArguments>;
    if (!parsed || typeof parsed.requestId !== 'string' || typeof parsed.digest !== 'string'
      || !(HUMAN_STEP_MODES as readonly string[]).includes(parsed.mode ?? '')) return undefined;
    return parsed as HumanTaskCallArguments;
  } catch {
    return undefined;
  }
}
