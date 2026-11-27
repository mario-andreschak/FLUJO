import {
  elicitationContentOf,
  elicitationErrors,
  elicitationFieldsOf,
  initialElicitationValues,
} from '@/frontend/components/Chat/elicitationForm';
import { vetElicitationUrl } from '@/shared/utils/elicitationUrl';

// Every field kind the 2026-07-28 elicitation schema allows.
const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name', minLength: 2, maxLength: 20 },
    email: { type: 'string', format: 'email' },
    site: { type: 'string', format: 'uri' },
    born: { type: 'string', format: 'date' },
    meeting: { type: 'string', format: 'date-time' },
    age: { type: 'integer', minimum: 18, maximum: 99 },
    ratio: { type: 'number', default: 0.5 },
    agree: { type: 'boolean', default: true },
    color: { type: 'string', enum: ['r', 'g'], enumNames: ['Red', 'Green'] },
    size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }], default: 'l' },
    tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['a', 'b', 'c'] } },
    pets: { type: 'array', items: { anyOf: [{ const: 'cat', title: 'Cat' }, { const: 'dog', title: 'Dog' }] } },
  },
  required: ['name', 'age', 'tags'],
};

describe('elicitation form fields (#1448)', () => {
  const fields = elicitationFieldsOf(schema);
  const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));

  it('renders every allowed type, titled choices and multi-select lists', () => {
    expect(fields.map((field) => [field.key, field.kind])).toEqual([
      ['name', 'text'], ['email', 'email'], ['site', 'uri'], ['born', 'date'], ['meeting', 'date-time'],
      ['age', 'integer'], ['ratio', 'number'], ['agree', 'boolean'], ['color', 'select'], ['size', 'select'],
      ['tags', 'multiselect'], ['pets', 'multiselect'],
    ]);
    expect(byKey.color.options).toEqual([{ value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }]);
    expect(byKey.size.options).toEqual([{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }]);
    expect(byKey.pets.options).toEqual([{ value: 'cat', label: 'Cat' }, { value: 'dog', label: 'Dog' }]);
    expect(byKey.name).toMatchObject({ label: 'Name', required: true, minLength: 2, maxLength: 20 });
  });

  it('fills in the server defaults and leaves the rest empty', () => {
    expect(initialElicitationValues(fields)).toMatchObject({
      name: '', age: '', ratio: '0.5', agree: true, size: 'l', tags: [], pets: [],
    });
  });

  it('checks answers before sending', () => {
    const values = {
      ...initialElicitationValues(fields),
      name: 'A', email: 'nope', site: 'not a url', born: '27.11.2026', age: '17.5', tags: ['a', 'b', 'c'],
    };
    expect(elicitationErrors(fields, values)).toEqual({
      name: 'minLength', email: 'email', site: 'uri', born: 'date', age: 'integer', tags: 'maxItems',
    });
    expect(elicitationErrors(fields, initialElicitationValues(fields))).toMatchObject({ name: 'required', age: 'required', tags: 'required' });
  });

  it('sends typed values and leaves out optional fields left empty', () => {
    const values = {
      ...initialElicitationValues(fields),
      name: 'Ada', age: '36', tags: ['b'], meeting: '2026-11-27T10:30', ratio: '',
    };
    expect(elicitationErrors(fields, values)).toEqual({});
    const content = elicitationContentOf(fields, values);
    expect(content).toEqual({
      name: 'Ada', age: 36, agree: true, size: 'l', tags: ['b'],
      meeting: new Date('2026-11-27T10:30').toISOString(),
    });
  });
});

describe('elicitation link checks (#1448)', () => {
  it('accepts https and local http, and flags look-alike hosts', () => {
    expect(vetElicitationUrl('https://accounts.example.com/connect?x=1')).toEqual({
      href: 'https://accounts.example.com/connect?x=1', host: 'accounts.example.com', lookalikeHost: false, insecureLocal: false,
    });
    expect(vetElicitationUrl('http://localhost:3000/cb')).toMatchObject({ host: 'localhost:3000', insecureLocal: true });
    expect(vetElicitationUrl('https://аpple.com/')).toMatchObject({ lookalikeHost: true });
  });

  it.each([
    'http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'https://user:pw@example.com',
    'https://bank.example@evil.example', 'ftp://example.com', 'https://exa mple.com', 'relative/path', 42,
  ])('refuses %p', (raw) => {
    expect(vetElicitationUrl(raw)).toBeUndefined();
  });
});
