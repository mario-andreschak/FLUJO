/**
 * Turns an MCP form request (`requestedSchema`, spec 2026-07-28) into fields,
 * checks the person's answers and builds the content sent back.
 *
 * The spec allows a flat object of strings (with `email`, `uri`, `date` and
 * `date-time` formats), numbers, integers, booleans, single-choice lists
 * (`enum`, `oneOf` with titles, or the older `enumNames`) and multi-choice
 * lists (`array` of `enum` or `anyOf` items). FLUJO renders every one of them.
 */
export type ElicitationFieldKind =
  | 'text' | 'email' | 'uri' | 'date' | 'date-time'
  | 'number' | 'integer' | 'boolean' | 'select' | 'multiselect';

export interface ElicitationOption { value: string; label: string }

export interface ElicitationField {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  kind: ElicitationFieldKind;
  options?: ElicitationOption[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  defaultValue?: unknown;
}

/** What the inputs hold while the person types: numbers stay text until sent. */
export type ElicitationValue = string | boolean | string[];
export type ElicitationValues = Record<string, ElicitationValue>;
export type ElicitationContent = Record<string, string | number | boolean | string[]>;

export type ElicitationFieldError =
  | 'required' | 'number' | 'integer' | 'minimum' | 'maximum' | 'minLength' | 'maxLength'
  | 'email' | 'uri' | 'date' | 'dateTime' | 'minItems' | 'maxItems' | 'option';

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function optionsOf(schema: JsonObject): ElicitationOption[] | undefined {
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (titled) {
    return titled.flatMap((entry) => isObject(entry) && typeof entry.const === 'string'
      ? [{ value: entry.const, label: textOf(entry.title) || entry.const }] : []);
  }
  if (!Array.isArray(schema.enum)) return undefined;
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  return schema.enum.flatMap((value, index) => typeof value === 'string'
    ? [{ value, label: textOf(names[index]) || value }] : []);
}

function kindOf(schema: JsonObject): { kind: ElicitationFieldKind; options?: ElicitationOption[] } {
  if (schema.type === 'array') {
    const items = isObject(schema.items) ? schema.items : {};
    return { kind: 'multiselect', options: optionsOf(items) ?? [] };
  }
  if (schema.type === 'boolean') return { kind: 'boolean' };
  if (schema.type === 'number') return { kind: 'number' };
  if (schema.type === 'integer') return { kind: 'integer' };
  const options = optionsOf(schema);
  if (options) return { kind: 'select', options };
  switch (schema.format) {
    case 'email': return { kind: 'email' };
    case 'uri': return { kind: 'uri' };
    case 'date': return { kind: 'date' };
    case 'date-time': return { kind: 'date-time' };
    default: return { kind: 'text' };
  }
}

export function elicitationFieldsOf(requestedSchema: unknown): ElicitationField[] {
  if (!isObject(requestedSchema) || !isObject(requestedSchema.properties)) return [];
  const required = new Set(Array.isArray(requestedSchema.required)
    ? requestedSchema.required.filter((key): key is string => typeof key === 'string') : []);
  return Object.entries(requestedSchema.properties).flatMap(([key, raw]) => {
    if (!isObject(raw)) return [];
    const { kind, options } = kindOf(raw);
    return [{
      key,
      label: textOf(raw.title) || key,
      ...(textOf(raw.description) ? { description: textOf(raw.description) } : {}),
      required: required.has(key),
      kind,
      ...(options ? { options } : {}),
      ...(numberOf(raw.minimum) !== undefined ? { minimum: numberOf(raw.minimum) } : {}),
      ...(numberOf(raw.maximum) !== undefined ? { maximum: numberOf(raw.maximum) } : {}),
      ...(numberOf(raw.minLength) !== undefined ? { minLength: numberOf(raw.minLength) } : {}),
      ...(numberOf(raw.maxLength) !== undefined ? { maxLength: numberOf(raw.maxLength) } : {}),
      ...(numberOf(raw.minItems) !== undefined ? { minItems: numberOf(raw.minItems) } : {}),
      ...(numberOf(raw.maxItems) !== undefined ? { maxItems: numberOf(raw.maxItems) } : {}),
      ...(raw.default !== undefined ? { defaultValue: raw.default } : {}),
    }];
  });
}

/** Starting values: the server's defaults, otherwise empty (and unticked). */
export function initialElicitationValues(fields: readonly ElicitationField[]): ElicitationValues {
  const values: ElicitationValues = {};
  for (const field of fields) {
    const fallback = field.defaultValue;
    if (field.kind === 'boolean') values[field.key] = fallback === true;
    else if (field.kind === 'multiselect') {
      values[field.key] = Array.isArray(fallback) ? fallback.filter((value): value is string => typeof value === 'string') : [];
    } else if (typeof fallback === 'string' || typeof fallback === 'number') values[field.key] = String(fallback);
    else values[field.key] = '';
  }
  return values;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function isUri(value: string): boolean {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function fieldError(field: ElicitationField, value: ElicitationValue | undefined): ElicitationFieldError | undefined {
  if (field.kind === 'boolean') return undefined;
  if (field.kind === 'multiselect') {
    const picked = Array.isArray(value) ? value : [];
    if (picked.length === 0) return field.required ? 'required' : undefined;
    if (picked.some((entry) => !field.options?.some((option) => option.value === entry))) return 'option';
    if (field.minItems !== undefined && picked.length < field.minItems) return 'minItems';
    if (field.maxItems !== undefined && picked.length > field.maxItems) return 'maxItems';
    return undefined;
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return field.required ? 'required' : undefined;
  if (field.kind === 'number' || field.kind === 'integer') {
    const number = Number(text);
    if (!Number.isFinite(number)) return 'number';
    if (field.kind === 'integer' && !Number.isInteger(number)) return 'integer';
    if (field.minimum !== undefined && number < field.minimum) return 'minimum';
    if (field.maximum !== undefined && number > field.maximum) return 'maximum';
    return undefined;
  }
  if (field.kind === 'select') return field.options?.some((option) => option.value === text) ? undefined : 'option';
  if (field.minLength !== undefined && text.length < field.minLength) return 'minLength';
  if (field.maxLength !== undefined && text.length > field.maxLength) return 'maxLength';
  if (field.kind === 'email' && !EMAIL.test(text)) return 'email';
  if (field.kind === 'uri' && !isUri(text)) return 'uri';
  if (field.kind === 'date' && !DATE.test(text)) return 'date';
  if (field.kind === 'date-time' && !DATE_TIME.test(text)) return 'dateTime';
  return undefined;
}

/** Problems to show next to each field; empty when the form may be sent. */
export function elicitationErrors(
  fields: readonly ElicitationField[],
  values: ElicitationValues,
): Record<string, ElicitationFieldError> {
  const errors: Record<string, ElicitationFieldError> = {};
  for (const field of fields) {
    const error = fieldError(field, values[field.key]);
    if (error) errors[field.key] = error;
  }
  return errors;
}

/** The answer sent to the server. Optional fields left empty are left out. */
export function elicitationContentOf(
  fields: readonly ElicitationField[],
  values: ElicitationValues,
): ElicitationContent {
  const content: ElicitationContent = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.kind === 'boolean') content[field.key] = value === true;
    else if (field.kind === 'multiselect') {
      const picked = Array.isArray(value) ? value : [];
      if (picked.length > 0 || field.required) content[field.key] = picked;
    } else {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) continue;
      content[field.key] = field.kind === 'number' || field.kind === 'integer' ? Number(text)
        : field.kind === 'date-time' ? dateTimeInputToIso(text) : text;
    }
  }
  return content;
}

/** A `date-time` input holds local time without a zone; send it as UTC (RFC 3339). */
export function dateTimeInputToIso(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}
