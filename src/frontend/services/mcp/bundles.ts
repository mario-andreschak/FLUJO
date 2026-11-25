/**
 * Browser side of installing an MCP bundle (.mcpb) file (#1230): send the file
 * for review, then send it again with the reviewed digest and the settings.
 */
import type {
  McpbErrorBody,
  McpbErrorCode,
  McpbInstallResult,
  McpbReview,
  McpbUserConfigValue,
} from '@/shared/types/mcp/mcpb';

/** `.dxt` is the old name of the same format. */
export function isMcpbFileName(name: string): boolean {
  return /\.(mcpb|dxt)$/i.test(name.trim());
}

export class McpbRequestError extends Error {
  readonly code?: McpbErrorCode;
  readonly fields: string[];
  readonly status: number;
  constructor(message: string, status: number, code?: McpbErrorCode, fields: string[] = []) {
    super(message);
    this.name = 'McpbRequestError';
    this.status = status;
    if (code) this.code = code;
    this.fields = fields;
  }
}

async function send<T>(form: FormData, unreachableMessage: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/mcp/bundles', { method: 'POST', body: form });
  } catch {
    throw new McpbRequestError(unreachableMessage, 0);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = (body && typeof body === 'object' ? body : {}) as Partial<McpbErrorBody>;
    throw new McpbRequestError(
      typeof error.error === 'string' ? error.error : `${unreachableMessage} (${response.status})`,
      response.status,
      error.code,
      Array.isArray(error.fields) ? error.fields.filter((field): field is string => typeof field === 'string') : [],
    );
  }
  return body as T;
}

export function reviewMcpbFile(file: File, unreachableMessage: string): Promise<McpbReview> {
  const form = new FormData();
  form.append('action', 'review');
  form.append('bundle', file, file.name);
  return send<McpbReview>(form, unreachableMessage);
}

export function installMcpbFile(
  file: File,
  input: { reviewedDigest: string; serverName: string; userConfig: Record<string, McpbUserConfigValue> },
  unreachableMessage: string,
): Promise<McpbInstallResult> {
  const form = new FormData();
  form.append('action', 'install');
  form.append('bundle', file, file.name);
  form.append('reviewedDigest', input.reviewedDigest);
  form.append('serverName', input.serverName);
  form.append('userConfig', JSON.stringify(input.userConfig));
  return send<McpbInstallResult>(form, unreachableMessage);
}
