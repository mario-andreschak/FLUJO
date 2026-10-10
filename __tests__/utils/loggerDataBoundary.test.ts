import { createLogger, LOG_LEVEL } from '@/utils/logger/logger';

describe('logger data boundary', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['verbose', 'debug', 'info', 'warn', 'error'] as const)('emits one physical record at %s level for forged line/control input', level => {
    const consoleMethod = level === 'verbose' ? 'debug' : level;
    const sink = jest.spyOn(console, consoleMethod).mockImplementation(() => {});
    createLogger('source\r\n[ERROR] forged', LOG_LEVEL.VERBOSE)[level]('message\n[INFO] forged\u2028next\u001b[2J', 'data\rforged');
    expect(sink).toHaveBeenCalledTimes(1);
    const record = sink.mock.calls[0][0] as string;
    expect(record).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(record).not.toContain(String.fromCharCode(27));
    expect(record).toContain('message');
    expect(record).toContain('data');
  });

  it('preserves special Error data keys and nested causes without changing prototypes', () => {
    const sink = jest.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('outer', { cause: new Error('inner') });
    Object.defineProperty(error, '__proto__', { value: { marker: 'retained-data' }, enumerable: true });
    Object.defineProperty(error, 'constructor', { value: 'data-constructor', enumerable: true });
    createLogger('logger-boundary', LOG_LEVEL.ERROR).error('payload', error);
    const output = sink.mock.calls[0][0] as string;
    const serialized = output.slice(output.indexOf('payload:') + 'payload:'.length).trim();
    const data = JSON.parse(serialized);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.hasOwn(data, '__proto__')).toBe(true);
    expect(data['__proto__']).toEqual({ marker: 'retained-data' });
    expect(data.constructor).toBe('data-constructor');
    expect(data.cause.message).toBe('inner');
    expect(Object.hasOwn(Object.prototype, 'marker')).toBe(false);
  });

  it('does not evaluate suppressed lazy data and evaluates emitted data once', () => {
    const sink = jest.spyOn(console, 'error').mockImplementation(() => {});
    const lazy = jest.fn(() => ({ result: 'once' }));
    const log = createLogger('logger-boundary', LOG_LEVEL.ERROR);
    log.debug('suppressed', lazy);
    expect(lazy).not.toHaveBeenCalled();
    log.error('emitted', lazy);
    expect(lazy).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it.each(['\u0000', '\b', '\t', '\u000b', '\f', '\u007f', '\u0085', '\u009b', '\u009d'])('neutralizes terminal control %j in raw paths and messages', control => {
    const sink = jest.spyOn(console, 'error').mockImplementation(() => {});
    createLogger(`source${control}label`, LOG_LEVEL.ERROR).error(`before${control}after with useful spaces`);
    expect(sink).toHaveBeenCalledTimes(1);
    const output = sink.mock.calls[0][0] as string;
    expect(output).not.toMatch(/\p{Control}/u);
    expect(output).toContain('with useful spaces');
    expect(output).toContain('before');
    expect(output).toContain('after');
  });

  it('keeps structured JSON data intact while escaping C1 terminal controls', () => {
    const sink = jest.spyOn(console, 'error').mockImplementation(() => {});
    const data = { text: 'useful spaces \u0085next \u009b31m red \u009dtitle', nested: { tab: '\t', backspace: '\b' } };
    createLogger('logger-boundary', LOG_LEVEL.ERROR).error('payload', () => data);
    const output = sink.mock.calls[0][0] as string;
    expect(output).not.toMatch(/\p{Control}/u);
    const serialized = output.slice(output.indexOf('payload:') + 'payload:'.length).trim();
    expect(JSON.parse(serialized)).toEqual(data);
  });
});
