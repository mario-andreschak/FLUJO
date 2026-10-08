/**
 * Tests for the experimental MCP v2-beta protocol support (spec revision 2026-07-28).
 *
 * Covers the three seams the feature adds:
 *  1. isMcpBetaProtocolEnabled — reads the experimental flag from the Settings blob,
 *     defaulting to disabled on a missing value or a storage failure.
 *  2. shouldRecreateClient — a toggle flip must rebuild the connection (a v1 client
 *     can never be reused as a beta client or vice versa), while a stable beta
 *     connection with an unchanged config must NOT be rebuilt (the restart-death-
 *     spiral guarantee extends to the beta path).
 *  3. createNewBetaClient / createBetaTransport — the factories mark their products
 *     (__flujoBeta / __flujoKind) and stash the SAME raw config keys the v1 path
 *     stashes, so recreate detection works identically across generations.
 */

const loadItemMock = jest.fn();
jest.mock("@/utils/storage/backend", () => ({
  loadItem: (...a: unknown[]) => loadItemMock(...a),
  saveItem: jest.fn(),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as BetaStdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createNewClient,
  createTransport,
  shouldRecreateClient,
  stdioConfigKey,
} from "@/backend/services/mcp/connection";
import {
  activateStdioOAuthMrtrController,
  isMcpBetaProtocolEnabled,
  isBetaClient,
  createNewBetaClient,
  createBetaTransport,
  getStdioOAuthMrtrController,
} from "@/backend/services/mcp/betaClient";
import type { MCPServerConfig, MCPStdioConfig } from "@/shared/types/mcp";

const stdio = (command = "node"): MCPServerConfig =>
  ({
    name: "srv",
    transport: "stdio",
    command,
    args: ["server.js"],
    env: {},
    disabled: false,
    rootPath: "",
    _buildCommand: "",
    _installCommand: "",
  }) as unknown as MCPServerConfig;

const streamable = (): MCPServerConfig =>
  ({
    name: "remote",
    transport: "streamable",
    serverUrl: "https://api.example.com/mcp",
    disabled: false,
  }) as unknown as MCPServerConfig;

/** Attach a transport as connect() would, so shouldRecreateClient sees it. */
function withTransport<T>(client: T, transport: unknown): T {
  (client as unknown as { _transport: unknown })._transport = transport;
  return client;
}

beforeEach(() => {
  loadItemMock.mockReset();
});

describe("isMcpBetaProtocolEnabled", () => {
  it("is disabled when the settings blob has no experimental section", async () => {
    loadItemMock.mockResolvedValue({ speech: { enabled: false } });
    expect(await isMcpBetaProtocolEnabled()).toBe(false);
  });

  it("is enabled when the flag is set", async () => {
    loadItemMock.mockResolvedValue({
      experimental: { enabled: true, mcpBetaProtocol: true },
    });
    expect(await isMcpBetaProtocolEnabled()).toBe(true);
  });

  it("is disabled when storage fails (best-effort read)", async () => {
    loadItemMock.mockRejectedValue(new Error("disk gone"));
    expect(await isMcpBetaProtocolEnabled()).toBe(false);
  });
});

describe("shouldRecreateClient — beta toggle flips", () => {
  it("rebuilds a v1 client when the beta protocol is enabled", () => {
    const config = stdio();
    const client = withTransport(
      createNewClient(config),
      createTransport(config),
    );

    const result = shouldRecreateClient(client, config, true);

    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toBe("Beta MCP protocol enabled");
  });

  it("rebuilds a beta client when the beta protocol is disabled again", () => {
    const config = stdio();
    const client = withTransport(
      createNewBetaClient(config),
      createBetaTransport(config),
    );

    const result = shouldRecreateClient(client, config, false);

    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toBe("Beta MCP protocol disabled");
  });

  it("does NOT treat the toggle as a change for websocket configs (v1-only transport)", () => {
    const config = {
      name: "ws",
      transport: "websocket",
      websocketUrl: "ws://localhost:9999",
      disabled: false,
    } as unknown as MCPServerConfig;
    const client = createNewClient(config);
    // A fake websocket transport can't pass the v1 instanceof check, so only assert
    // the beta-flip reason is NOT what forces the rebuild here.
    const result = shouldRecreateClient(client, config, true);
    expect(result.reason).not.toBe("Beta MCP protocol enabled");
  });
});

describe("shouldRecreateClient — stable beta connections", () => {
  it("does NOT rebuild a beta stdio client for a byte-identical config", () => {
    const config = stdio();
    const client = withTransport(
      createNewBetaClient(config),
      createBetaTransport(config),
    );

    const result = shouldRecreateClient(client, stdio(), true);

    expect(result.needsNewClient).toBe(false);
  });

  it("rebuilds a beta stdio client when the spawn parameters changed", () => {
    const client = withTransport(
      createNewBetaClient(stdio("node")),
      createBetaTransport(stdio("node")),
    );

    const result = shouldRecreateClient(client, stdio("deno"), true);

    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toBe("Connection parameters changed");
  });

  it("does NOT rebuild a beta streamable client for a byte-identical config", () => {
    const config = streamable();
    const client = withTransport(
      createNewBetaClient(config),
      createBetaTransport(config),
    );

    const result = shouldRecreateClient(client, streamable(), true);

    expect(result.needsNewClient).toBe(false);
  });

  it("rebuilds a beta client when the transport type changed", () => {
    const config = stdio();
    const client = withTransport(
      createNewBetaClient(config),
      createBetaTransport(config),
    );

    const result = shouldRecreateClient(client, streamable(), true);

    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toMatch(/transport type/i);
  });
});

describe("beta factories", () => {
  it("marks beta clients and leaves v1 clients unmarked", () => {
    expect(isBetaClient(createNewBetaClient(stdio()))).toBe(true);
    expect(isBetaClient(createNewClient(stdio()) as Client)).toBe(false);
  });

  it("stashes the SAME stdio config key as the v1 transport factory", () => {
    const config = stdio();
    const beta = createBetaTransport(config) as unknown as {
      __flujoStdioKey?: string;
      __flujoKind?: string;
    };
    const v1 = createTransport(config) as unknown as {
      __flujoStdioKey?: string;
    };

    expect(beta.__flujoKind).toBe("stdio");
    expect(beta.__flujoStdioKey).toBe(stdioConfigKey(config as MCPStdioConfig));
    expect(beta.__flujoStdioKey).toBe(v1.__flujoStdioKey);
  });

  it("keeps the exact base stdio transport through negotiation and defers MRTR attachment", () => {
    const beta = createBetaTransport(stdio()) as BetaStdioClientTransport & {
      __flujoKind?: string;
    };
    const controller = getStdioOAuthMrtrController(beta);

    expect(beta.__flujoKind).toBe("stdio");
    expect(beta).toBeInstanceOf(BetaStdioClientTransport);
    expect(Object.getPrototypeOf(beta)).toBe(
      BetaStdioClientTransport.prototype,
    );
    expect(controller).toBeDefined();
    expect(controller).not.toBe(beta);

    // connect() installs the SDK callbacks before FLUJO activates the adapter.
    beta.onmessage = jest.fn();
    activateStdioOAuthMrtrController(beta);
    expect(Object.getPrototypeOf(beta)).toBe(
      BetaStdioClientTransport.prototype,
    );
    expect(getStdioOAuthMrtrController(beta)).toBe(controller);
  });

  it("stashes kind + http key on streamable transports and refuses websocket", () => {
    const beta = createBetaTransport(streamable()) as unknown as {
      __flujoHttpKey?: string;
      __flujoKind?: string;
    };
    expect(beta.__flujoKind).toBe("streamable");
    expect(typeof beta.__flujoHttpKey).toBe("string");

    expect(() =>
      createBetaTransport({
        name: "ws",
        transport: "websocket",
        websocketUrl: "ws://x",
      } as unknown as MCPServerConfig),
    ).toThrow(/websocket/i);
  });
});
