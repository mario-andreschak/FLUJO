import { HarnessComparisonInputSchema } from '@/shared/types/harnessComparison';
import {
  buildComparisonInput,
  casesToRows,
  emptyExampleRow,
  emptyVariantRow,
  rowsFromJson,
  rowsFromPaste,
  rowsToCases,
  rowsToJson,
  toolResultsFromCell,
  toolResultsToCell,
  type ExampleRow,
} from '@/frontend/components/HarnessLab/comparisonDraft';

const row = (patch: Partial<ExampleRow>): ExampleRow => ({ ...emptyExampleRow(), ...patch });
const variant = (flowId: string) => ({ ...emptyVariantRow(), flowId });

describe('comparison examples as text', () => {
  it('keeps every field when going from JSON to the table and back', () => {
    const cases = [{
      id: 'first',
      input: 'When do you open?',
      required: ['8', 'nine to five'],
      forbidden: ['I think'],
      expectedTools: ['opening_hours'],
      forbiddenTools: ['send_it'],
      toolResults: { opening_hours: 'Open: from 8\nClosed: Sunday', other: '"quoted"' },
    }];
    const read = rowsFromJson(JSON.stringify(cases));
    expect(read.problem).toBeUndefined();
    expect(JSON.parse(rowsToJson(read.rows!))).toEqual(cases);
  });

  it('reads a whole API request too, using only its examples', () => {
    const read = rowsFromJson(JSON.stringify({ name: 'x', variants: [], cases: [{ input: 'a' }] }));
    expect(read.rows?.map((item) => item.input)).toEqual(['a']);
  });

  it('names the example and field that are wrong, and says when it is not JSON at all', () => {
    expect(rowsFromJson('[{ "input": "a" },').problem?.code).toBe('syntax');
    expect(rowsFromJson('{"input":"a"}').problem?.code).toBe('notAList');
    expect(rowsFromJson('[{"input":"a"},{"input":"b","required":"not a list"}]').problem)
      .toMatchObject({ code: 'example', example: 2, message: expect.stringContaining('required') });
    expect(rowsFromJson('[{"input":"a","typo":1}]').problem).toMatchObject({ code: 'example', example: 1 });
  });

  it('treats an empty box as no examples, not as an error', () => {
    expect(rowsFromJson('   ')).toEqual({ rows: [] });
  });

  it('does not count rows nobody filled in, but does count a row with only a check', () => {
    expect(rowsToCases([row({}), row({ input: '  ' })])).toEqual([]);
    expect(rowsToCases([row({ required: 'x' })])).toHaveLength(1);
  });

  it('reads tool answers with colons, quotes and carried-on lines', () => {
    expect(toolResultsFromCell('a: b: c\nd: "x\\ny"\nnot a tool line')).toEqual({ a: 'b: c', d: 'x\ny\nnot a tool line' });
    expect(toolResultsFromCell('  \n')).toBeUndefined();
    const answers = { tool: 'line one\nline two', other: 'plain: text' };
    expect(toolResultsFromCell(toolResultsToCell(answers))).toEqual(answers);
  });

  it('survives a cell of nothing but a broken quote', () => {
    expect(toolResultsFromCell('tool: "not closed')).toEqual({ tool: '"not closed' });
  });
});

describe('pasted rows', () => {
  it('reads columns in table order and splits several values', () => {
    const [first, second] = rowsFromPaste('When?\t8;nine\tI think\thours;other\tsend\thours: 8\nHow?');
    expect(first).toMatchObject({ input: 'When?', required: '8\nnine', forbidden: 'I think', expectedTools: 'hours\nother', forbiddenTools: 'send', toolResults: 'hours: 8' });
    expect(second).toMatchObject({ input: 'How?', required: '' });
  });

  it('reads a quoted spreadsheet cell with a line break as one example', () => {
    const rows = rowsFromPaste('"two\nlines"\tx\r\nnext\ty');
    expect(rows.map((item) => item.input)).toEqual(['two\nlines', 'next']);
  });

  it('keeps text with a stray quote instead of losing the following rows', () => {
    expect(rowsFromPaste('"open quote\tx\nnext\ty').map((item) => item.input)).toEqual(['"open quote', 'next']);
  });

  it('skips a heading row and blank lines', () => {
    expect(rowsFromPaste('Question\tMust contain\n\nreal\tx\n', 'question').map((item) => item.input)).toEqual(['real']);
  });
});

describe('building the request', () => {
  const ready = { name: 'n', variants: [variant('f')], rows: [row({ input: 'q' })], maxModelCallsPerCase: 8 };

  it('builds what the API accepts', () => {
    const built = buildComparisonInput({ ...ready, variants: [{ ...variant('f'), modelId: 'm', label: ' L ' }] });
    expect(built.problem).toBeUndefined();
    expect(HarnessComparisonInputSchema.safeParse(built.input).success).toBe(true);
    expect(built.input?.variants[0]).toEqual({ flowId: 'f', modelId: 'm', label: 'L' });
  });

  it.each([
    ['name', { name: '  ' }, { code: 'name' }],
    ['variants', { variants: [] }, { code: 'noVariant' }],
    ['too many variants', { variants: Array.from({ length: 9 }, () => variant('f')) }, { code: 'tooManyVariants' }],
    ['a flow', { variants: [variant('f'), variant('')] }, { code: 'variantFlow', variant: 2 }],
    ['examples', { rows: [row({})] }, { code: 'noExamples' }],
    ['too many examples', { rows: Array.from({ length: 201 }, (_, index) => row({ input: `q${index}` })) }, { code: 'tooManyExamples' }],
    ['an example with checks but no question', { rows: [row({ input: 'ok' }), row({ required: 'x' })] }, { code: 'example', example: 2 }],
    ['repeated ids', { rows: casesToRows([{ id: 'a', input: 'x' }, { id: 'a', input: 'y' }]) }, { code: 'duplicateId', id: 'a' }],
    ['an id clashing with an automatic one', { rows: casesToRows([{ id: 'case-2', input: 'x' }, { input: 'y' }]) }, { code: 'duplicateId', id: 'case-2' }],
    ['the call limit', { maxModelCallsPerCase: 41 }, { code: 'other' }],
    ['a call limit that is not a number', { maxModelCallsPerCase: Number('x') }, { code: 'other' }],
  ])('stops without %s', (_, change, problem) => {
    expect(buildComparisonInput({ ...ready, ...change }).problem).toMatchObject(problem);
  });

  it('takes 200 examples, the limit', () => {
    const rows = Array.from({ length: 200 }, (_, index) => row({ input: `q${index}` }));
    expect(buildComparisonInput({ ...ready, rows }).input?.cases).toHaveLength(200);
  });
});
