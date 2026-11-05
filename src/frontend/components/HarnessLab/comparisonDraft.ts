/**
 * The comparison form as text: examples as table cells, JSON and pasted rows.
 *
 * Kept free of React so all three views can be shown to mean the same thing. The table
 * holds the text as typed, so a half-written cell is not rewritten under the cursor, and
 * everything is read into the API's shape only when it is needed.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  HarnessComparisonCaseListSchema,
  HarnessComparisonInputSchema,
  MAX_COMPARISON_CASES,
  MAX_COMPARISON_VARIANTS,
  harnessComparisonCaseId,
  type HarnessComparisonCase,
  type HarnessComparisonInput,
} from '@/shared/types/harnessComparison';

export interface ExampleRow {
  key: string;
  id?: string;
  input: string;
  required: string;
  forbidden: string;
  expectedTools: string;
  forbiddenTools: string;
  toolResults: string;
}

export interface VariantRow {
  key: string;
  flowId: string;
  modelId: string;
  label: string;
}

export type DraftProblem =
  | { code: 'name' | 'noVariant' | 'noExamples' | 'tooManyVariants' | 'tooManyExamples' }
  | { code: 'variantFlow'; variant: number }
  | { code: 'duplicateId'; id: string }
  | { code: 'example'; example: number; message: string }
  | { code: 'other'; message: string };

export function emptyExampleRow(): ExampleRow {
  return { key: uuidv4(), input: '', required: '', forbidden: '', expectedTools: '', forbiddenTools: '', toolResults: '' };
}

export function emptyVariantRow(): VariantRow {
  return { key: uuidv4(), flowId: '', modelId: '', label: '' };
}

const linesOf = (cell: string) => cell.split('\n').map((line) => line.trim()).filter(Boolean);

/** One `tool: answer` per line. An answer with a line break is kept in quotes. */
export function toolResultsToCell(results: Record<string, string> | undefined): string {
  return Object.entries(results ?? {})
    .map(([name, answer]) => `${name}: ${answer.includes('\n') || answer.startsWith('"') ? JSON.stringify(answer) : answer}`)
    .join('\n');
}

export function toolResultsFromCell(cell: string): Record<string, string> | undefined {
  const results: Record<string, string> = {};
  let last: string | undefined;
  for (const line of cell.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) {
      // A line that names no tool carries on the answer before it.
      if (last !== undefined) results[last] += `\n${line}`;
      else results[line.trim()] = '';
      if (last === undefined) last = line.trim();
      continue;
    }
    const name = line.slice(0, colon).trim();
    const answer = line.slice(colon + 1).trim();
    let value = answer;
    if (answer.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(answer);
        if (typeof parsed === 'string') value = parsed;
      } catch { /* Not quoted after all, so the text stands as typed. */ }
    }
    results[name] = value;
    last = name;
  }
  return Object.keys(results).length > 0 ? results : undefined;
}

const isBlank = (row: ExampleRow) => !row.id && !row.input.trim() && !row.required.trim() && !row.forbidden.trim()
  && !row.expectedTools.trim() && !row.forbiddenTools.trim() && !row.toolResults.trim();

/** A row nobody filled in is not an example, so it does not count or block a start. */
export function rowsToCases(rows: readonly ExampleRow[]) {
  return rows.filter((row) => !isBlank(row)).map((row) => {
    const required = linesOf(row.required);
    const forbidden = linesOf(row.forbidden);
    const expectedTools = linesOf(row.expectedTools);
    const forbiddenTools = linesOf(row.forbiddenTools);
    const toolResults = toolResultsFromCell(row.toolResults);
    return {
      ...(row.id ? { id: row.id } : {}),
      input: row.input.trim(),
      ...(required.length ? { required } : {}),
      ...(forbidden.length ? { forbidden } : {}),
      ...(expectedTools.length ? { expectedTools } : {}),
      ...(forbiddenTools.length ? { forbiddenTools } : {}),
      ...(toolResults ? { toolResults } : {}),
    };
  });
}

export function casesToRows(cases: ReadonlyArray<Partial<HarnessComparisonCase> & { input: string }>): ExampleRow[] {
  return cases.map((example) => ({
    key: uuidv4(),
    ...(example.id ? { id: example.id } : {}),
    input: example.input,
    required: (example.required ?? []).join('\n'),
    forbidden: (example.forbidden ?? []).join('\n'),
    expectedTools: (example.expectedTools ?? []).join('\n'),
    forbiddenTools: (example.forbiddenTools ?? []).join('\n'),
    toolResults: toolResultsToCell(example.toolResults),
  }));
}

export function rowsToJson(rows: readonly ExampleRow[]): string {
  return JSON.stringify(rowsToCases(rows), null, 2);
}

export type JsonReadResult =
  | { rows: ExampleRow[]; problem?: undefined }
  | { rows?: undefined; problem: DraftProblem | { code: 'syntax' | 'notAList'; message?: string } };

/** Takes a list of examples, or an object with `cases`, such as a whole API request. */
export function rowsFromJson(text: string): JsonReadResult {
  if (!text.trim()) return { rows: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { problem: { code: 'syntax', message: cause instanceof Error ? cause.message : undefined } };
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(list)) return { problem: { code: 'notAList' } };
  const checked = HarnessComparisonCaseListSchema.safeParse(list);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const [index, ...field] = issue.path;
    return { problem: { code: 'example', example: Number(index) + 1, message: [field.join('.'), issue.message].filter(Boolean).join(': ') } };
  }
  return { rows: casesToRows(checked.data) };
}

/** Splits tab-separated text as a spreadsheet copies it, where a quoted cell can hold line breaks. */
function splitPastedCells(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === '\t') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) {
    // An opening quote with no closing one was plain text, so read it again as plain lines.
    return text.split(/\r?\n/).map((line) => line.split('\t'));
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

const pastedList = (cell: string | undefined) => (cell ?? '').split(/[;\n]/).map((part) => part.trim()).filter(Boolean).join('\n');

/**
 * Rows from pasted text: one example per line, with the columns of the table in order.
 * Several values in a cell are separated by `;`. A first line that only repeats the
 * column heading is not an example.
 */
export function rowsFromPaste(text: string, headerLabel?: string): ExampleRow[] {
  const rows = splitPastedCells(text).filter((cells) => cells.some((cell) => cell.trim()));
  const first = rows[0]?.[0]?.trim().toLowerCase();
  const start = first && headerLabel && first === headerLabel.trim().toLowerCase() ? 1 : 0;
  return rows.slice(start).map((cells) => ({
    ...emptyExampleRow(),
    input: (cells[0] ?? '').trim(),
    required: pastedList(cells[1]),
    forbidden: pastedList(cells[2]),
    expectedTools: pastedList(cells[3]),
    forbiddenTools: pastedList(cells[4]),
    toolResults: (cells[5] ?? '').trim(),
  }));
}

export type DraftResult =
  | { input: HarnessComparisonInput; problem?: undefined }
  | { input?: undefined; problem: DraftProblem };

/** The request to send, or the first thing that stops it, numbered as the form shows it. */
export function buildComparisonInput(draft: {
  name: string;
  variants: readonly VariantRow[];
  rows: readonly ExampleRow[];
  maxModelCallsPerCase: number;
}): DraftResult {
  if (!draft.name.trim()) return { problem: { code: 'name' } };
  if (draft.variants.length === 0) return { problem: { code: 'noVariant' } };
  if (draft.variants.length > MAX_COMPARISON_VARIANTS) return { problem: { code: 'tooManyVariants' } };
  const missingFlow = draft.variants.findIndex((variant) => !variant.flowId);
  if (missingFlow >= 0) return { problem: { code: 'variantFlow', variant: missingFlow + 1 } };
  const cases = rowsToCases(draft.rows);
  if (cases.length === 0) return { problem: { code: 'noExamples' } };
  if (cases.length > MAX_COMPARISON_CASES) return { problem: { code: 'tooManyExamples' } };
  const parsed = HarnessComparisonInputSchema.safeParse({
    name: draft.name,
    variants: draft.variants.map((variant) => ({
      flowId: variant.flowId,
      ...(variant.modelId ? { modelId: variant.modelId } : {}),
      ...(variant.label.trim() ? { label: variant.label.trim() } : {}),
    })),
    cases,
    maxModelCallsPerCase: draft.maxModelCallsPerCase,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue.path[0] === 'cases') {
      const [, index, ...field] = issue.path;
      return { problem: { code: 'example', example: Number(index) + 1, message: [field.join('.'), issue.message].filter(Boolean).join(': ') } };
    }
    return { problem: { code: 'other', message: `${issue.path.join('.')}: ${issue.message}` } };
  }
  const ids = parsed.data.cases.map(harnessComparisonCaseId);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated) return { problem: { code: 'duplicateId', id: repeated } };
  return { input: parsed.data };
}
