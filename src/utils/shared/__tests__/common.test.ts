import { isSecretEnvVar, toolBindingRegex } from '../common';

describe('common utilities', () => {
  describe('isSecretEnvVar', () => {
    test.each([
      ['API_KEY', true],
      ['SECRET_TOKEN', true],
      ['DB_PASSWORD', true],
      ['AUTH_TOKEN', true],
      ['APP_NAME', false],
      ['PORT', false],
      ['DATABASE_URL', false],
    ])('should correctly identify %s as secret: %s', (key, expected) => {
      expect(isSecretEnvVar(key)).toBe(expected);
    });

    test('should be case insensitive', () => {
      expect(isSecretEnvVar('API_Key')).toBe(true);
      expect(isSecretEnvVar('Secret_VALUE')).toBe(true);
    });
  });

  describe('toolBindingRegex', () => {
    it('should match valid patterns', () => {
      const testCases = [
        '${tool}',
        '${tool_name}',
        '${my-tool}',
        '${tool123}'
      ];
      testCases.forEach(testCase => {
        const matches = testCase.match(toolBindingRegex);
        expect(matches).not.toBeNull();
      });
    });

    it('should not match invalid patterns', () => {
      const testCases = [
        'tool',
        '{tool}',
        '$tool',
        '${too/many/parts}',
        '${invalid*chars}',
        '${_-_-_too_-_-_many_-_-_parts}'
      ];
      testCases.forEach(testCase => {
        const matches = testCase.match(toolBindingRegex);
        expect(matches).toBeNull();
      });
    });
  });
}); 