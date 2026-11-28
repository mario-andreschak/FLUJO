/**
 * Tests for the experimental MCP v2-beta protocol support (spec revision 2026-07-28).
 *
 * Covers the three seams the feature adds:
 *  1. isMcpBetaProtocolEnabled — always true since #1449; negotiation falls back
 *     to the classic handshake per server.
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
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport as BetaInMemoryTransport } from "@modelcontextprotocol/client";
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
import { installTrustedHostProfile } from './fixtures/trustedHostProfile';
import { fingerprintTrustedHostExecutable } from './fixtures/trustedHostFingerprint';

let approvedHost: ReturnType<typeof installTrustedHostProfile>;
const stdio = (command = "node"): MCPStdioConfig => {
  const executable = command === 'node' ? approvedHost.config.command : approvedHost.alternateCommand;
  const config: MCPStdioConfig = { ...approvedHost.config, command: executable,
    trustedHost: { ...approvedHost.config.trustedHost!, entryPoint: executable,
      executableDigest: fingerprintTrustedHostExecutable(executable) } };
  approvedHost.approve(config);
  return config;
};

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
  approvedHost = installTrustedHostProfile({ name: 'srv' });
});
afterEach(() => approvedHost.restore());

describe("isMcpBetaProtocolEnabled", () => {
  const savedNegotiation = process.env.FLUJO_MCP_PROTOCOL_NEGOTIATION;
  afterEach(() => {
    if (savedNegotiation === undefined) delete process.env.FLUJO_MCP_PROTOCOL_NEGOTIATION;
    else process.env.FLUJO_MCP_PROTOCOL_NEGOTIATION = savedNegotiation;
  });

  it("always negotiates the modern protocol; old settings and the retired variable change nothing (#1449)", async () => {
    process.env.FLUJO_MCP_PROTOCOL_NEGOTIATION = "legacy";
    loadItemMock.mockResolvedValue({ experimental: { mcpBetaProtocol: false } });
    expect(await isMcpBetaProtocolEnabled()).toBe(true);
    expect(loadItemMock).not.toHaveBeenCalled();
  });
});

describe("shouldRecreateClient — beta toggle flips", () => {
  it("rebuilds a v1 client when the beta protocol is enabled", async () => {
    const config = stdio();
    const client = withTransport(
      createNewClient(config),
      await createTransport(config),
    );

    const result = shouldRecreateClient(client, config, true);

    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toBe("Beta MCP protocol enabled");
  });

  it("rebuilds a beta client when the beta protocol is disabled again", async () => {
    const config = stdio();
    const client = withTransport(
      createNewBetaClient(config),
      await createBetaTransport(config),
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
  it("does NOT rebuild a beta stdio client for a byte-identical config", async () => {
    const config = stdio();
    const client = withTransport(
      createNewBetaClient(config),
      await createBetaTransport(config),
    );

    const result = shouldRecreateClient(client, stdio(), true);

    expect(result.needsNewClient).toBe(false);
  });

  it("rebuilds a beta stdio client when the spawn parameters changed", async () => {
    const client = withTransport(
      createNewBetaClient(stdio("node")),
      await createBetaTransport(stdio("node")),
    );

    const result = shouldRecreateClient(client, stdio("deno"), true);

    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toBe("Connection parameters changed");
  });

  it("does NOT rebuild a beta streamable client for a byte-identical config", async () => {
    const config = streamable();
    const client = withTransport(
      createNewBetaClient(config),
      await createBetaTransport(config),
    );

    const result = shouldRecreateClient(client, streamable(), true);

    expect(result.needsNewClient).toBe(false);
  });

  it("rebuilds a beta client when the transport type changed", async () => {
    const config = stdio();
    const client = withTransport(
      createNewBetaClient(config),
      await createBetaTransport(config),
    );

    const result = shouldRecreateClient(client, streamable(), true);

    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toMatch(/transport type/i);
  });
});

describe("beta factories", () => {
  it("delivers resource, Claude channel and MCP events notifications to the handlers it was built with", async () => {
    const seen: Array<[string, unknown]> = [];
    const methods = [
      "notifications/resources/updated",
      "notifications/claude/channel",
      "notifications/events/event",
    ];
    const handlers = Object.fromEntries(methods.map(method => [method, (params: unknown) => { seen.push([method, params]); }]));
    const client = createNewBetaClient(stdio(), undefined, undefined, handlers);
    const server = new Server({ name: "srv", version: "1" }, { capabilities: { resources: { subscribe: true } } });
    const [clientSide, serverSide] = BetaInMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide as never)]);
    await server.notification({ method: "notifications/resources/updated", params: { uri: "file:///a" } });
    await server.notification({ method: "notifications/claude/channel", params: { content: "hi" } });
    await server.notification({ method: "notifications/events/event", params: { eventId: "e", name: "n" } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(seen).toEqual([
      ["notifications/resources/updated", expect.objectContaining({ uri: "file:///a" })],
      ["notifications/claude/channel", expect.objectContaining({ content: "hi" })],
      ["notifications/events/event", expect.objectContaining({ eventId: "e" })],
    ]);
    await client.close();
  });

  it("marks beta clients and leaves v1 clients unmarked", () => {
    expect(isBetaClient(createNewBetaClient(stdio()))).toBe(true);
    expect(isBetaClient(createNewClient(stdio()) as Client)).toBe(false);
  });

  it("stashes the SAME stdio config key as the v1 transport factory", async () => {
    const config = stdio();
    const beta = (await createBetaTransport(config)) as unknown as {
      __flujoStdioKey?: string;
      __flujoKind?: string;
    };
    const v1 = (await createTransport(config)) as unknown as {
      __flujoStdioKey?: string;
    };

    expect(beta.__flujoKind).toBe("stdio");
    expect(beta.__flujoStdioKey).toBe(stdioConfigKey(config as MCPStdioConfig));
    expect(beta.__flujoStdioKey).toBe(v1.__flujoStdioKey);
  });

  it("hands the SDK a stdio subclass, so the server/discover probe runs on FLUJO's own process, and defers MRTR attachment", async () => {
    const beta = (await createBetaTransport(stdio())) as BetaStdioClientTransport & {
      __flujoKind?: string;
    };
    const controller = getStdioOAuthMrtrController(beta);

    expect(beta.__flujoKind).toBe("stdio");
    expect(beta).toBeInstanceOf(BetaStdioClientTransport);
    // The SDK clones only its exact base class into a hidden probe process.
    expect(Object.getPrototypeOf(beta)).not.toBe(BetaStdioClientTransport.prototype);
    expect(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(beta), "_dispose")).toBe(false);
    expect(controller).toBeDefined();
    expect(controller).not.toBe(beta);

    // connect() installs the SDK callbacks before FLUJO activates the adapter.
    const prototype = Object.getPrototypeOf(beta);
    beta.onmessage = jest.fn();
    activateStdioOAuthMrtrController(beta);
    expect(Object.getPrototypeOf(beta)).toBe(prototype);
    expect(getStdioOAuthMrtrController(beta)).toBe(controller);
  });

  it("asks stdio servers server/discover with a bounded probe, remote servers in auto mode", () => {
    const negotiation = (client: unknown) => (client as { _versionNegotiation: unknown })._versionNegotiation;
    expect(negotiation(createNewBetaClient(stdio()))).toEqual({ mode: "auto", probe: { timeoutMs: 20_000 } });
    expect(negotiation(createNewBetaClient(streamable()))).toEqual({ mode: "auto" });
  });

  it("stashes kind + http key on streamable transports and refuses websocket", async () => {
    const beta = (await createBetaTransport(streamable())) as unknown as {
      __flujoHttpKey?: string;
      __flujoKind?: string;
    };
    expect(beta.__flujoKind).toBe("streamable");
    expect(typeof beta.__flujoHttpKey).toBe("string");

    await expect(createBetaTransport({
        name: "ws",
        transport: "websocket",
        websocketUrl: "ws://x",
      } as unknown as MCPServerConfig)).rejects.toThrow(/websocket/i);
  });
});
