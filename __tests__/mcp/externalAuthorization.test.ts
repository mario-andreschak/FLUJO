import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  captureExternalAuthorizationElicitation,
  cancelExternalAuthorization,
  confirmExternalAuthorization,
  declineExternalAuthorization,
  getExternalAuthorizationStatus,
  prepareExternalAuthorization,
  registerExternalAuthorizationClient,
} from "@/backend/services/mcp/externalAuthorization";
import {
  STDIO_OAUTH_EXTENSION_CAPABILITY,
  STDIO_OAUTH_EXTENSION_ID,
} from "mcp-stdio-oauth/protocol";

function fakeClient(
  serverName: string,
  request: (input: {
    method: string;
    params?: Record<string, unknown>;
  }) => Promise<unknown>,
): Client {
  const client = {
    getServerCapabilities: () => ({
      extensions: {
        [STDIO_OAUTH_EXTENSION_ID]: STDIO_OAUTH_EXTENSION_CAPABILITY,
      },
    }),
    registerCapabilities: jest.fn(),
    request,
  } as unknown as Client;
  registerExternalAuthorizationClient(client, serverName);
  return client;
}

describe("MCP external authorization extension", () => {
  it("derives a blocking readiness requirement from the fixed status method", async () => {
    const client = fakeClient("status-test-server", async ({ method }) => {
      expect(method).toBe(`${STDIO_OAUTH_EXTENSION_ID}/status`);
      return {
        authorizations: [
          {
            id: "google-workspace",
            label: "Google Workspace",
            state: "authorization_required",
            blocksUnattendedUse: true,
          },
        ],
      };
    });

    const status = await getExternalAuthorizationStatus(
      client,
      "status-test-server",
      { force: true },
    );

    expect(status.supported).toBe(true);
    expect(status.blockingAuthorization?.id).toBe("google-workspace");
  });

  it("does not infer support from an incompatible extension capability", async () => {
    const request = jest.fn();
    const client = {
      getServerCapabilities: () => ({
        extensions: {
          [STDIO_OAUTH_EXTENSION_ID]: { version: "1.0" },
        },
      }),
      registerCapabilities: jest.fn(),
      request,
    } as unknown as Client;
    registerExternalAuthorizationClient(
      client,
      "incompatible-extension-server",
    );

    await expect(
      getExternalAuthorizationStatus(client, "incompatible-extension-server", {
        force: true,
      }),
    ).resolves.toEqual({ supported: false, authorizations: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not accept unilateral advertisement from a remote/unbound client", async () => {
    const request = jest.fn();
    const client = {
      getServerCapabilities: () => ({
        extensions: {
          [STDIO_OAUTH_EXTENSION_ID]: STDIO_OAUTH_EXTENSION_CAPABILITY,
        },
      }),
      request,
    } as unknown as Client;

    await expect(
      getExternalAuthorizationStatus(client, "remote-unilateral-server", {
        force: true,
      }),
    ).resolves.toEqual({ supported: false, authorizations: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it("captures URL elicitation only inside a user-started extension request", async () => {
    const client = fakeClient("gmail-test-server", async ({ method }) => {
      if (method.endsWith("/start")) {
        const elicitation = await captureExternalAuthorizationElicitation(
          "gmail-test-server",
          {
            mode: "url",
            url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
            message: "Sign in to Google",
          },
        );
        expect(elicitation).toEqual({ action: "accept" });
        return {
          authorizationId: "google-workspace",
          state: "authorization_pending",
        };
      }
      return {
        authorizations: [
          {
            id: "google-workspace",
            label: "Google Workspace",
            state: "authorization_required",
          },
        ],
      };
    });

    const prompt = await prepareExternalAuthorization(
      client,
      "gmail-test-server",
      "google-workspace",
    );
    expect(prompt.origin).toBe("https://accounts.google.com");

    const confirmed = confirmExternalAuthorization(
      "gmail-test-server",
      prompt.sessionId,
    );
    expect(confirmed.url).toContain("accounts.google.com");
  });

  it("returns decline separately from cancel", async () => {
    const seen: string[] = [];
    const client = fakeClient("decline-server", async ({ method }) => {
      if (method.endsWith("/start")) {
        const result = await captureExternalAuthorizationElicitation(
          "decline-server",
          {
            mode: "url",
            url: "https://provider.example/authorize",
            message: "Authorize",
          },
        );
        seen.push(result?.action ?? "missing");
        return { authorizationId: "account", state: "authorization_required" };
      }
      return {
        authorizations: [
          { id: "account", label: "Account", state: "authorization_required" },
        ],
      };
    });

    const prompt = await prepareExternalAuthorization(
      client,
      "decline-server",
      "account",
    );
    expect(
      declineExternalAuthorization("decline-server", prompt.sessionId),
    ).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toEqual(["decline"]);
  });

  it("cancels unsolicited URL elicitation and never exposes it to UI", async () => {
    await expect(
      captureExternalAuthorizationElicitation("unsolicited-server", {
        mode: "url",
        url: "https://example.com/authorize",
      }),
    ).resolves.toEqual({ action: "cancel" });
  });

  it("cancels malformed URL-mode elicitation instead of treating it as a form", async () => {
    await expect(
      captureExternalAuthorizationElicitation("malformed-url-server", {
        mode: "url",
        url: "",
      }),
    ).resolves.toEqual({ action: "cancel" });
  });

  it("rejects insecure non-loopback authorization URLs", async () => {
    const client = fakeClient("insecure-url-server", async ({ method }) => {
      if (method.endsWith("/start")) {
        await captureExternalAuthorizationElicitation("insecure-url-server", {
          mode: "url",
          url: "http://evil.example/authorize",
          message: "Sign in",
        });
        return { authorizationId: "account", state: "authorization_required" };
      }
      return {
        authorizations: [
          { id: "account", label: "Account", state: "authorization_required" },
        ],
      };
    });

    await expect(
      prepareExternalAuthorization(client, "insecure-url-server", "account"),
    ).rejects.toThrow("HTTPS");
  });

  it("surfaces a warning marker for Punycode authorization hosts", async () => {
    const client = fakeClient("punycode-url-server", async ({ method }) => {
      if (method.endsWith("/start")) {
        await captureExternalAuthorizationElicitation("punycode-url-server", {
          mode: "url",
          url: "https://xn--bcher-kva.example/authorize",
          message: "Sign in",
        });
        return { authorizationId: "account", state: "authorization_required" };
      }
      return {
        authorizations: [
          { id: "account", label: "Account", state: "authorization_required" },
        ],
      };
    });

    const prompt = await prepareExternalAuthorization(
      client,
      "punycode-url-server",
      "account",
    );
    expect(prompt.hasPunycode).toBe(true);
    expect(prompt.origin).toBe("https://xn--bcher-kva.example");
    confirmExternalAuthorization("punycode-url-server", prompt.sessionId);
  });

  it("rejects a completed start that bypasses URL elicitation", async () => {
    const client = fakeClient("no-elicitation-server", async ({ method }) => {
      if (method.endsWith("/start")) {
        return { authorizationId: "account", state: "authorization_required" };
      }
      return {
        authorizations: [
          {
            id: "account",
            label: "Account",
            state: "authorization_required",
            blocksUnattendedUse: true,
          },
        ],
      };
    });

    await expect(
      prepareExternalAuthorization(client, "no-elicitation-server", "account"),
    ).rejects.toThrow("without URL elicitation");
  });

  it("does not treat a non-ready nonblocking authorization as ready", async () => {
    const client = fakeClient(
      "nonblocking-not-ready-server",
      async ({ method }) => {
        if (method.endsWith("/start")) {
          return {
            authorizationId: "account",
            state: "authorization_required",
          };
        }
        return {
          authorizations: [
            {
              id: "account",
              label: "Optional account",
              state: "authorization_required",
              blocksUnattendedUse: false,
            },
          ],
        };
      },
    );

    await expect(
      prepareExternalAuthorization(
        client,
        "nonblocking-not-ready-server",
        "account",
      ),
    ).rejects.toThrow("without URL elicitation");
  });

  it("keeps a cancelled start correlated until it settles", async () => {
    let releaseOldStart!: () => void;
    const oldStartCanFinish = new Promise<void>((resolve) => {
      releaseOldStart = resolve;
    });
    const lateResult: Array<string | undefined> = [];
    const client = fakeClient(
      "correlation-server",
      async ({ method, params }) => {
        if (method.endsWith("/start")) {
          const id = params?.authorizationId;
          if (id === "old") {
            const first = await captureExternalAuthorizationElicitation(
              "correlation-server",
              {
                mode: "url",
                url: "https://old.example/authorize",
                message: "Old request",
              },
            );
            expect(first?.action).toBe("cancel");
            await oldStartCanFinish;
            const late = await captureExternalAuthorizationElicitation(
              "correlation-server",
              {
                mode: "url",
                url: "https://late-old.example/authorize",
                message: "Late old request",
              },
            );
            lateResult.push(late?.action);
            return { authorizationId: "old", state: "authorization_required" };
          }
          return { authorizationId: "new", state: "authorization_required" };
        }
        return {
          authorizations: [
            { id: "old", label: "Old", state: "authorization_required" },
            { id: "new", label: "New", state: "authorization_required" },
          ],
        };
      },
    );

    const oldPrompt = await prepareExternalAuthorization(
      client,
      "correlation-server",
      "old",
    );
    expect(
      cancelExternalAuthorization("correlation-server", oldPrompt.sessionId),
    ).toBe(true);
    await expect(
      prepareExternalAuthorization(client, "correlation-server", "new"),
    ).rejects.toThrow("still closing");

    releaseOldStart();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lateResult).toEqual(["cancel"]);
  });

  it("keeps a pre-elicitation cancellation as a tombstone until start settles", async () => {
    let markOldStartEntered!: () => void;
    const oldStartEntered = new Promise<void>((resolve) => {
      markOldStartEntered = resolve;
    });
    let releaseLateElicitation!: () => void;
    const lateElicitationMayRun = new Promise<void>((resolve) => {
      releaseLateElicitation = resolve;
    });
    const lateActions: Array<string | undefined> = [];
    const client = fakeClient(
      "pre-elicitation-cancel-server",
      async ({ method, params }) => {
        if (method.endsWith("/start")) {
          if (params?.authorizationId === "old") {
            markOldStartEntered();
            await lateElicitationMayRun;
            const result = await captureExternalAuthorizationElicitation(
              "pre-elicitation-cancel-server",
              {
                mode: "url",
                url: "https://late.example/authorize",
              },
            );
            lateActions.push(result?.action);
            return { authorizationId: "old", state: "authorization_required" };
          }
          return { authorizationId: "new", state: "authorization_required" };
        }
        return {
          authorizations: [
            { id: "old", label: "Old", state: "authorization_required" },
            { id: "new", label: "New", state: "authorization_required" },
          ],
        };
      },
    );

    const oldOutcome = prepareExternalAuthorization(
      client,
      "pre-elicitation-cancel-server",
      "old",
    ).catch((error: unknown) => error);
    await oldStartEntered;
    expect(cancelExternalAuthorization("pre-elicitation-cancel-server")).toBe(
      true,
    );
    await expect(
      prepareExternalAuthorization(
        client,
        "pre-elicitation-cancel-server",
        "new",
      ),
    ).rejects.toThrow("still closing");

    releaseLateElicitation();
    expect(await oldOutcome).toBeInstanceOf(Error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lateActions).toEqual(["cancel"]);
  });

  it("keeps a malformed elicitation tombstoned until its start settles", async () => {
    let releaseOldStart!: () => void;
    const oldStartMayFinish = new Promise<void>((resolve) => {
      releaseOldStart = resolve;
    });
    const lateActions: Array<string | undefined> = [];
    const client = fakeClient(
      "malformed-correlation-server",
      async ({ method, params }) => {
        if (method.endsWith("/start")) {
          if (params?.authorizationId === "old") {
            await captureExternalAuthorizationElicitation(
              "malformed-correlation-server",
              { mode: "url", url: "" },
            );
            await oldStartMayFinish;
            const late = await captureExternalAuthorizationElicitation(
              "malformed-correlation-server",
              {
                mode: "url",
                url: "https://late.example/authorize",
              },
            );
            lateActions.push(late?.action);
            return { authorizationId: "old", state: "authorization_required" };
          }
          return { authorizationId: "new", state: "authorization_required" };
        }
        return {
          authorizations: [
            { id: "old", label: "Old", state: "authorization_required" },
            { id: "new", label: "New", state: "authorization_required" },
          ],
        };
      },
    );

    await expect(
      prepareExternalAuthorization(
        client,
        "malformed-correlation-server",
        "old",
      ),
    ).rejects.toThrow("malformed authorization URL");
    await expect(
      prepareExternalAuthorization(
        client,
        "malformed-correlation-server",
        "new",
      ),
    ).rejects.toThrow("still closing");

    releaseOldStart();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lateActions).toEqual(["cancel"]);
  });
});
