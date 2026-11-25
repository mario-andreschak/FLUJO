import type { TranslationKey } from '@/frontend/i18n/messages';

/**
 * Slash commands typed at the start of a chat message (#1225).
 *
 * Only a known command name at the very start counts. Anything else, such as
 * an unknown "/word", a path like "/usr/bin" or a known name glued to more
 * letters, is ordinary text and is sent to the AI unchanged.
 */
export const SLASH_COMMAND_IDS = ['goal', 'compact', 'new', 'fork', 'context', 'status', 'help'] as const;
export type SlashCommandId = typeof SLASH_COMMAND_IDS[number];

export interface SlashCommandSpec {
  id: SlashCommandId;
  /** The typed name, without the slash. */
  name: string;
  /** True when text may follow the name, as in "/goal <text>". */
  acceptsArgs: boolean;
  description: TranslationKey;
  argsHint?: TranslationKey;
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { id: 'goal', name: 'goal', acceptsArgs: true, description: 'chat.slash.goal.description', argsHint: 'chat.slash.goal.args' },
  { id: 'compact', name: 'compact', acceptsArgs: false, description: 'chat.slash.compact.description' },
  { id: 'new', name: 'new', acceptsArgs: false, description: 'chat.slash.new.description' },
  { id: 'fork', name: 'fork', acceptsArgs: false, description: 'chat.slash.fork.description' },
  { id: 'context', name: 'context', acceptsArgs: false, description: 'chat.slash.context.description' },
  { id: 'status', name: 'status', acceptsArgs: false, description: 'chat.slash.status.description' },
  { id: 'help', name: 'help', acceptsArgs: false, description: 'chat.slash.help.description' },
];

export interface ParsedSlashCommand {
  command: SlashCommandSpec;
  args: string;
}

const COMMAND_PATTERN = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/;

/** A known command at the start of the message, or null for ordinary text. */
export function parseSlashCommand(
  text: string,
  commands: readonly SlashCommandSpec[] = SLASH_COMMANDS,
): ParsedSlashCommand | null {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const command = commands.find(candidate => candidate.name === name);
  if (!command) return null;
  const args = (match[2] ?? '').trim();
  // Text after a command that takes none is kept as a message, never dropped.
  if (args && !command.acceptsArgs) return null;
  return { command, args };
}

/**
 * "//goal …" sends "/goal …" as an ordinary message. Only a doubled slash in
 * front of a known command changes; "// note" and "//path" stay as typed.
 */
export function literalSlashText(
  text: string,
  commands: readonly SlashCommandSpec[] = SLASH_COMMANDS,
): string | null {
  const leading = text.length - text.trimStart().length;
  const body = text.slice(leading);
  if (!body.startsWith('//')) return null;
  return parseSlashCommandName(body.slice(1), commands)
    ? text.slice(0, leading) + body.slice(1)
    : null;
}

function parseSlashCommandName(text: string, commands: readonly SlashCommandSpec[]): boolean {
  const match = /^\/([A-Za-z][\w-]*)(?=\s|$)/.exec(text);
  return Boolean(match && commands.some(command => command.name === match[1].toLowerCase()));
}

/**
 * The partial command name while the message is still only "/" plus a word,
 * which is when the command menu shows. Null once a space or a new line follows.
 */
export function findSlashQuery(text: string): string | null {
  const match = /^\/([\w-]*)$/.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** Words this short match too many descriptions to help. */
const DESCRIPTION_SEARCH_MIN = 3;

/** Names that start with the query first, then names or descriptions that contain it. */
export function filterSlashCommands(
  commands: readonly SlashCommandSpec[],
  query: string,
  describe: (command: SlashCommandSpec) => string = () => '',
): SlashCommandSpec[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  const starts = commands.filter(command => command.name.startsWith(needle));
  const contains = commands.filter(command => !starts.includes(command)
    && (command.name.includes(needle)
      || (needle.length >= DESCRIPTION_SEARCH_MIN && describe(command).toLowerCase().includes(needle))));
  return [...starts, ...contains];
}

export type SlashNoticeTone = 'info' | 'success' | 'warning' | 'error';

/** The short answer a command shows above the message box. */
export interface SlashCommandNotice {
  tone: SlashNoticeTone;
  title: string;
  lines?: string[];
  /** The chat the notice belongs to, when the command opened another one. */
  conversationId?: string;
}

export type SlashCommandAvailability =
  | { available: true }
  | { available: false; reason: string };

/** What the chat page offers the message box for running commands. */
export interface SlashCommandHost {
  availability: (id: SlashCommandId) => SlashCommandAvailability;
  run: (id: SlashCommandId, args: string) => Promise<SlashCommandNotice | null>;
}
