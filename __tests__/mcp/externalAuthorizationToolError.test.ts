jest.mock("@/backend/utils/resolveGlobalVars", () => ({
  resolveGlobalVars: jest.fn(async (value: unknown) => value),
}));

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { callTool } from "@/backend/services/mcp/tools";
import { registerExternalAuthorizationClient } from "@/backend/services/mcp/externalAuthorization";
import {
  STDIO_OAUTH_EXTENSION_CAPABILITY,
  STDIO_OAUTH_EXTENSION_ID,
} from "mcp-stdio-oauth/protocol";

function negotiatedClient(error: unknown): {
  client: Client;
  statusRequest: jest.Mock;
} {
  const statusRequest = jest.fn(async () => ({
    authorizations: [
      {
        id: "google-workspace",
        label: "Google Workspace",
        state: "authorization_required",
      },
    ],
  }));
  const client = {
    getServerCapabilities: () => ({
      extensions: {
        [STDIO_OAUTH_EXTENSION_ID]: STDIO_OAUTH_EXTENSION_CAPABILITY,
      },
    }),
    registerCapabilities: jest.fn(),
    request: statusRequest,
    callTool: jest.fn().mockRejectedValue(error),
  } as unknown as Client;
  registerExternalAuthorizationClient(client, "revoked-server");
  return { client, statusRequest };
}

describe("external authorization structured tool errors", () => {
  it("maps a namespaced revocation error to authentication-required", async () => {
    const { client, statusRequest } = negotiatedClient(
      new McpError(-32042, "Authorization expired", {
        [STDIO_OAUTH_EXTENSION_ID]: {
          authorizationId: "google-workspace",
          state: "authorization_required",
          message: "Sign in to Google Workspace again.",
        },
      }),
    );

    const result = await callTool(
      client,
      "revoked-server",
      "list_messages",
      {},
    );

    expect(result).toMatchObject({
      success: false,
      error: "Sign in to Google Workspace again.",
      errorType: "stdio-oauth-required",
      requiresAuthentication: true,
      statusCode: 428,
    });
    expect(statusRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: `${STDIO_OAUTH_EXTENSION_ID}/status` }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("detects a structurally valid modern/plain error independent of its code", async () => {
    const { client } = negotiatedClient({
      code: -39999,
      message: "Provider credentials changed",
      data: {
        [STDIO_OAUTH_EXTENSION_ID]: {
          authorizationId: "google-workspace",
          state: "authorization_required",
          message: "Authorize again.",
        },
      },
    });

    await expect(
      callTool(client, "revoked-server", "list_messages", {}),
    ).resolves.toMatchObject({
      errorType: "stdio-oauth-required",
      error: "Authorize again.",
    });
  });

  it("ignores the namespace when the extension was not mutually negotiated", async () => {
    const client = {
      callTool: jest.fn().mockRejectedValue({
        code: -32042,
        message: "Unnegotiated namespace",
        data: {
          [STDIO_OAUTH_EXTENSION_ID]: {
            authorizationId: "account",
            state: "authorization_required",
          },
        },
      }),
    } as unknown as Client;

    const result = await callTool(client, "remote-server", "list_messages", {});
    expect(result.errorType).not.toBe("stdio-oauth-required");
  });
});
