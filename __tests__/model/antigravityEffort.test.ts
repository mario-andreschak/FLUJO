import {
  ANTIGRAVITY_EFFORT_LEVELS, antigravityEffortVariant, antigravityModelTakesEffort, groupAntigravityEfforts,
} from '@/shared/types/model/antigravityEffort';
import { normalizeAntigravityCatalog } from '@/backend/services/model/adapters/antigravityCliDiscovery';
import { parseAntigravityModels } from '@/backend/services/model/adapters/antigravityCliProcess';

// `agy models` from the official CLI 1.4.8 with an API key (recorded on Nov 27, 2026).
const RECORDED_CATALOG = [
  'gemini-4-argon-high\tGemini 4 Argon (High)', 'gemini-4-argon-medium\tGemini 4 Argon (Medium)', 'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)', 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)', 'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)', 'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)', 'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)', 'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)', 'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)', '',
].join('\n');

test('the recorded CLI list folds into one model per base name with the levels the CLI lists', () => {
  expect(normalizeAntigravityCatalog(JSON.parse(parseAntigravityModels(RECORDED_CATALOG))).map(({ id, name, reasoningEfforts }) => ({ id, name, reasoningEfforts })))
    .toEqual([
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', reasoningEfforts: ['low', 'high'] },
    ]);
});

test('models without levels stay as they are and a listed base name keeps its own label', () => {
  expect(groupAntigravityEfforts([
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'gemini-9-pro-max', name: 'Gemini 9 Pro (Maximum)' },
    { id: 'gemini-9-pro', name: 'Gemini 9 Pro (default)' },
    { id: 'gemini-9-pro-xhigh', name: 'Gemini 9 Pro (Extra high)' },
  ])).toEqual([
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'gemini-9-pro', name: 'Gemini 9 Pro (default)', reasoningEfforts: ['xhigh', 'max'] },
  ]);
});

test('entries are left apart when their names do not describe one model', () => {
  const unrelated = [
    { id: 'tide-high', name: 'Tide (High)' },
    { id: 'tide-low', name: 'Low Tide (Low)' },
    { id: 'plain-high', name: 'Plain High' },
  ];
  expect(groupAntigravityEfforts(unrelated)).toEqual(unrelated);
});

test('only a named model without a level in its name takes --effort', () => {
  expect(antigravityEffortVariant('gemini-3.1-pro-high')).toEqual({ base: 'gemini-3.1-pro', effort: 'high' });
  expect(antigravityEffortVariant('gemini-3.1-pro')).toBeUndefined();
  expect(antigravityEffortVariant('-high')).toBeUndefined();
  expect(['gemini-3.1-pro', 'custom-model'].every(antigravityModelTakesEffort)).toBe(true);
  expect(['default', ' ', 'gemini-3.1-pro-low', 'gemini-4-argon-max'].some(antigravityModelTakesEffort)).toBe(false);
  expect(ANTIGRAVITY_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
});
