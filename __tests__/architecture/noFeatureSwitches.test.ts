/**
 * FLUJO has no feature switches (#1449): a feature is on by default and falls
 * back by itself, or it is removed. This keeps new environment variables, code
 * switches and on/off settings from creeping back in.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { FEATURES } from '@/config/features';
import { ENVIRONMENT_ALLOWLIST } from '@/shared/environmentAllowlist';
import { RETIRED_EXPERIMENTAL_SETTINGS } from '@/shared/config/retiredSettings';

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'src');
const HOW_TO_FIX = 'Make the feature work without it: on by default, with an automatic fallback when it cannot work (#1449).';

/** Every on/off field the settings types may have, and why a person decides it. */
const SETTINGS_SWITCHES: Record<string, string> = {
  'SpeechSettings.enabled': 'The user decides whether FLUJO listens and speaks.',
  'UpdateSettings.checkOnStartup': 'The user decides whether FLUJO contacts the update server.',
  'OnboardingSettings.completed': 'Records that the guided tour is done; not a switch.',
  'OnboardingSettings.dashboardCardsHidden': 'The user hid the start cards.',
  'TelemetrySettings.enabled': 'Privacy: the user decides whether usage counts leave the machine.',
  'TelemetrySettings.notifyDaily': 'Privacy: the user decides whether to see each daily report.',
  'NetworkSettings.allowAllMcpAppContent': 'Security: the owner widens what MCP Apps may load.',
  'ExperimentalSettings.requireMcpAppLaunchClick': 'Security: the user wants every MCP App to wait for a click.',
  'ExperimentalSettings.restrictMcpFilesystemToRoots': 'Security: the user confines tool servers to chosen folders.',
  'ModelAccessSettings.directModelCalls': 'Security: the owner can close direct model calls on the API.',
  'ModelAccessSettings.quickChat': 'Security: the owner can close Quick Chat and what is built on it.',
  'McpStartupSettings.lazyStart': 'The user trades start-up time for first-use time.',
  'ExperimentalSettings.claudeSessionResume': 'Pending: always true; ModelHandler.ts (#571 split) still reads it.',
  'ExperimentalSettings.autoUnloadOllamaModels': 'Pending: always true; ModelHandler.ts (#571 split) still reads it.',
  'ExperimentalSettings.compactionEnabled': 'Pending: ignored; ModelHandler.ts (#571 split) still reads it.',
  'ExperimentalSettings.visualCompactionEnabled': 'Pending: ignored; ModelHandler.ts (#571 split) still reads it.',
  'ExperimentalSettings.visualCompactionToolResultsOnly': 'Pending: ignored; ModelHandler.ts (#571 split) still reads it.',
  'ExperimentalSettings.visualCompactionEvaluationMode': 'Pending: ignored; ModelHandler.ts (#571 split) still reads it.',
};

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:tsx?|mjs|cjs|js)$/.test(entry.name) ? [file] : [];
  });
}

function isEnvironmentObject(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === 'env' && ts.isIdentifier(node.expression) && node.expression.text === 'process';
  }
  return ts.isIdentifier(node) && (node.text === 'env' || node.text === 'environment');
}

/** Names `src/` reads from the environment; a `FLUJO_X_${...}` template reads the prefix `FLUJO_X_*`. */
function environmentReads(): Map<string, Set<string>> {
  const reads = new Map<string, Set<string>>();
  const add = (name: string, file: string) => {
    const files = reads.get(name) ?? new Set<string>();
    files.add(path.relative(ROOT, file).split(path.sep).join('/'));
    reads.set(name, files);
  };
  for (const file of sourceFiles(SOURCE)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isEnvironmentObject(node.expression)
        && /^[A-Z][A-Za-z0-9_]+$/.test(node.name.text)) add(node.name.text, file);
      if (ts.isElementAccessExpression(node) && isEnvironmentObject(node.expression)
        && ts.isStringLiteralLike(node.argumentExpression)) add(node.argumentExpression.text, file);
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^FLUJO_[A-Z0-9_]+$/.test(node.text)) {
        add(node.text, file);
      }
      if (ts.isTemplateHead(node) && /^FLUJO_[A-Z0-9_]+$/.test(node.text)) add(`${node.text}*`, file);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return reads;
}

function settingsBooleans(): string[] {
  const file = path.join(SOURCE, 'shared', 'types', 'storage', 'storage.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || !node.name.text.endsWith('Settings')) return;
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.type?.kind === ts.SyntaxKind.BooleanKeyword
        && ts.isIdentifier(member.name)) found.push(`${node.name.text}.${member.name.text}`);
    }
  });
  return found;
}

describe('no feature switches (#1449)', () => {
  const reads = environmentReads();

  it('reads only environment variables listed with a reason', () => {
    const unlisted = [...reads.keys()].filter((name) => !ENVIRONMENT_ALLOWLIST[name]);
    const message = unlisted.map((name) => `${name} (${[...reads.get(name)!].join(', ')})`).join('\n');
    expect({
      problem: unlisted.length ? `src/ reads environment variables that src/shared/environmentAllowlist.ts does not list:\n${message}` : 'none',
      fix: HOW_TO_FIX,
    }).toEqual({ problem: 'none', fix: HOW_TO_FIX });
  });

  it('lists no environment variable that src/ stopped reading', () => {
    const stale = Object.entries(ENVIRONMENT_ALLOWLIST)
      .filter(([name, entry]) => entry.kind !== 'operator' && !reads.has(name))
      .map(([name]) => name);
    expect({ stale, fix: 'Delete these names from src/shared/environmentAllowlist.ts.' })
      .toEqual({ stale: [], fix: 'Delete these names from src/shared/environmentAllowlist.ts.' });
  });

  it('gives every listed environment variable a reason', () => {
    const missing = Object.entries(ENVIRONMENT_ALLOWLIST)
      .filter(([, entry]) => entry.reason.trim().length < 10)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('has no code switches', () => {
    expect({ switches: Object.keys(FEATURES).sort(), fix: HOW_TO_FIX })
      .toEqual({ switches: ['LOG_LEVEL'], fix: HOW_TO_FIX });
  });

  it('has only on/off settings a person must decide', () => {
    const unlisted = settingsBooleans().filter((name) => !SETTINGS_SWITCHES[name]);
    const removed = Object.keys(SETTINGS_SWITCHES).filter((name) => !settingsBooleans().includes(name));
    expect({ unlisted, removed, fix: `${HOW_TO_FIX} Only privacy, security and real user choices belong in SETTINGS_SWITCHES.` })
      .toEqual({ unlisted: [], removed: [], fix: `${HOW_TO_FIX} Only privacy, security and real user choices belong in SETTINGS_SWITCHES.` });
  });

  it('never brings a retired setting back into the settings types', () => {
    const pending = Object.keys(SETTINGS_SWITCHES)
      .filter((name) => SETTINGS_SWITCHES[name].startsWith('Pending'))
      .map((name) => name.split('.')[1]);
    const returned = RETIRED_EXPERIMENTAL_SETTINGS
      .filter((name) => !pending.includes(name) && settingsBooleans().includes(`ExperimentalSettings.${name}`));
    expect(returned).toEqual([]);
  });
});
