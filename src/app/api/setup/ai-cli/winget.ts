export const AI_CLI_PACKAGES = {
  claude: { id: 'Anthropic.ClaudeCode', label: 'Claude Code' },
  codex: { id: 'OpenAI.Codex', label: 'Codex CLI' },
  ollama: { id: 'Ollama.Ollama', label: 'Ollama' },
} as const;

export type AiCliTool = keyof typeof AI_CLI_PACKAGES;

export function buildWingetArgs(tool: AiCliTool): string[] {
  return [
    'install',
    '--id', AI_CLI_PACKAGES[tool].id,
    '-e',
    '--source', 'winget',
    '--accept-source-agreements',
    '--accept-package-agreements',
    '--silent',
  ];
}
