/**
 * Regression tests for the MCP restart death-spiral (connection.ts half).
 *
 * Root cause 1 (Finding A): shouldRecreateClient compared the transport's REWRITTEN
 * spawn params (bare `node` -> absolute path, .bat -> cmd.exe) against the RAW config,
 * so a byte-identical config always read as "parameters changed" and every reconnect
 * attempt killed and respawned a healthy server.
 *
 * Root cause 2 (Finding B): safelyCloseClient called client.close() while the child was
 * still shutting down; the SDK's hardcoded stdin -> 2s -> SIGTERM -> 2s -> SIGKILL
 * ladder then hard-killed servers mid-teardown (orphaning their own child processes).
 * The fix waits for the child's exit before client.close().
 *
 * Issue #413 changed the escalation half: instead of signalling the immediate child
 * (usually only a shell / npx wrapper, which orphans the real server and everything it
 * spawned), safelyCloseClient now escalates through the awaited, exit-verifying
 * killProcessTreeAndWait, which terminates the whole descendant tree and REPORTS
 * whether it actually died. These tests therefore assert the tree-teardown contract:
 * stdin-first grace, exactly one awaited tree kill, no direct child signalling, and a
 * bounded close that still tears the client down when the tree refuses to die. The
 * platform-specific ladder itself (taskkill /T /F vs negative-pid SIGTERM/SIGKILL) is
 * covered in __tests__/process/killProcessTree.test.ts.
 */
import { EventEmitter } from "events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

jest.mock("@/utils/process/killProcessTree", () => {
  const actual = jest.requireActual("@/utils/process/killProcessTree");
  return {
    ...actual,
    killProcessTreeAndWait: jest.fn(actual.killProcessTreeAndWait),
  };
});

import {
  createStdioTransport,
  shouldRecreateClient,
  safelyCloseClient,
  capabilityKey,
} from "@/backend/services/mcp/connection";
import { MCPServerConfig } from "@/shared/types/mcp";
import { killProcessTreeAndWait } from "@/utils/process/killProcessTree";

const killProcessTreeAndWaitMock = jest.mocked(killProcessTreeAndWait);

function stdioConfig(overrides: Record<string, unknown> = {}): MCPServerConfig {
  return {
    name: "wa-test",
    transport: "stdio",
    command: "node",
    args: ["dist/index.js"],
    env: {},
    disabled: false,
    autoApprove: [],
    rootPath: "C:/servers/wa-test",
    _buildCommand: "",
    _installCommand: "",
    ...overrides,
  } as unknown as MCPServerConfig;
}

/** Fake client wrapping a transport; shouldRecreateClient only reads transport + cap key. */
function fakeClientFor(transport: unknown, config: MCPServerConfig): Client {
  return {
    transport,
    // Mirrors capabilityKey() in connection.ts (sampling + elicitation). Roots are NOT part
    // of the key (issue 46): the capability is always declared and roots changes never rebuild.
    __flujoCapKey: capabilityKey(config),
  } as unknown as Client;
}

describe("shouldRecreateClient stdio config comparison", () => {
  it("treats a byte-identical config as unchanged even though the spawn command was rewritten", () => {
    // Bare `node` is rewritten to an absolute path at transport creation time
    // (resolveNodeCommand). The old comparison read that as "parameters changed" and
    // killed a healthy server on every reconnect attempt.
    const config = stdioConfig();
    const transport = createStdioTransport(config);
    const client = fakeClientFor(transport, config);

    const result = shouldRecreateClient(client, stdioConfig());
    expect(result).toEqual({ needsNewClient: false });
  });

  it("detects a real args change", () => {
    const config = stdioConfig();
    const transport = createStdioTransport(config);
    const client = fakeClientFor(transport, config);

    const result = shouldRecreateClient(
      client,
      stdioConfig({ args: ["dist/other.js"] }),
    );
    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toBe("Connection parameters changed");
  });

  it("detects a real env change, including { value } shaped secrets", () => {
    const config = stdioConfig({ env: { TOKEN: { value: "a" } } });
    const transport = createStdioTransport(config);
    const client = fakeClientFor(transport, config);

    // Same value in flat form is NOT a change...
    expect(
      shouldRecreateClient(client, stdioConfig({ env: { TOKEN: "a" } }))
        .needsNewClient,
    ).toBe(false);
    // ...a different value is.
    expect(
      shouldRecreateClient(client, stdioConfig({ env: { TOKEN: "b" } }))
        .needsNewClient,
    ).toBe(true);
  });

  it("rebuilds a transport that has no config key (created before the key mechanism)", () => {
    const config = stdioConfig();
    const bareTransport = new StdioClientTransport({
      command: "node",
      args: [],
    });
    const client = fakeClientFor(bareTransport, config);

    const result = shouldRecreateClient(client, config);
    expect(result.needsNewClient).toBe(true);
  });
});

interface FakeStdin {
  destroyed: boolean;
  end: jest.Mock;
}

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdin: FakeStdin;
  kill: jest.Mock;

  constructor() {
    super();
    this.stdin = { destroyed: false, end: jest.fn() };
    this.kill = jest.fn(() => {
      this.killed = true;
      return true;
    });
  }

  exitNow(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function clientWithChild(child: FakeChild, events: string[]): Client {
  // A real StdioClientTransport (never started) passes the instanceof check; the child
  // is injected where the transport would keep its spawned process.
  const transport = new StdioClientTransport({ command: "node", args: [] });
  (transport as unknown as { _process: unknown })._process = child;
  return {
    transport,
    close: jest.fn(async () => {
      events.push("client.close");
    }),
  } as unknown as Client;
}

describe("safelyCloseClient graceful shutdown", () => {
  it("unwraps protocol decorators before inspecting the stdio child process", async () => {
    const events: string[] = [];
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => {
      events.push("stdin.end");
      child.exitNow(0);
    });
    const client = clientWithChild(child, events);
    const inner = client.transport;
    (client as unknown as { transport: unknown }).transport = {
      __flujoInnerTransport: inner,
    };

    await safelyCloseClient(client, "decorated-stdio", undefined, {
      gracePeriodMs: 2000,
    });

    expect(events).toEqual(["stdin.end", "client.close"]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("waits for the child to exit after stdin close BEFORE calling client.close(), no kill", async () => {
    const events: string[] = [];
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => {
      events.push("stdin.end");
      setTimeout(() => {
        events.push("exit");
        child.exitNow(0);
      }, 20);
    });
    const client = clientWithChild(child, events);

    await safelyCloseClient(client, "wa-test", undefined, {
      gracePeriodMs: 2000,
    });

    // The old implementation called client.close() immediately after stdin.end, letting
    // the SDK's 2s kill ladder land mid-teardown. Order is the regression assertion.
    expect(events).toEqual(["stdin.end", "exit", "client.close"]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("escalates the whole POSIX process group through SIGTERM then SIGKILL when the child never exits", async () => {
    const events: string[] = [];
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => events.push("stdin.end"));
    const client = clientWithChild(child, events);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const kill = jest.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      events.push(String(signal));
      return true;
    }) as never);
    let killCalls: unknown[][] = [];

    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await safelyCloseClient(client, "wa-test", undefined, {
        gracePeriodMs: 30,
        killEscalationMs: 30,
      });
    } finally {
      killCalls = kill.mock.calls.map(call => [...call]);
      kill.mockRestore();
      Object.defineProperty(process, "platform", platform!);
    }

    // A shell wrapper must never be signalled directly: escalation targets its
    // descendant process group, and client.close waits until that bounded ladder ends.
    expect(child.kill).not.toHaveBeenCalled();
    expect(events).toEqual(["stdin.end", "SIGTERM", "SIGKILL", "client.close"]);
    expect(killCalls).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
  });

  it("does not SIGKILL when tree SIGTERM makes the child exit", async () => {
    const events: string[] = [];
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => events.push("stdin.end"));
    const client = clientWithChild(child, events);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const kill = jest.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      events.push(String(signal));
      if (signal === "SIGTERM") {
        setTimeout(() => child.exitNow(1), 5);
      }
      return true;
    }) as never);
    let killCalls: unknown[][] = [];

    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await safelyCloseClient(client, "wa-test", undefined, {
        gracePeriodMs: 30,
        killEscalationMs: 1000,
      });
    } finally {
      killCalls = kill.mock.calls.map(call => [...call]);
      kill.mockRestore();
      Object.defineProperty(process, "platform", platform!);
    }

    expect(child.kill).not.toHaveBeenCalled();
    expect(events).toEqual(["stdin.end", "SIGTERM", "client.close"]);
    expect(killCalls).toEqual([[-child.pid, "SIGTERM"]]);
  });

  it("accepts a successful descendant-aware tree termination", async () => {
    const events: string[] = [];
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => {});
    const client = clientWithChild(child, events);
    killProcessTreeAndWaitMock.mockResolvedValueOnce({
      exited: true,
      forced: true,
      durationMs: 5,
    });

    const result = await safelyCloseClient(client, "wa-test", undefined, {
      gracePeriodMs: 30,
      killEscalationMs: 1000,
    });

    expect(killProcessTreeAndWaitMock).toHaveBeenCalledWith(child, {
      graceMs: 1000,
      finalWaitMs: 1000,
    });
    expect(result).toMatchObject({ exited: true, forced: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(events).toContain("client.close");
  });

  it("lets a REAL child with slow teardown exit naturally instead of being killed", async () => {
    // Real-process integration check for Finding B: a server that needs ~3s to shut
    // down after stdin closes (e.g. a browser teardown). The SDK's own close() ladder
    // SIGTERMs at 2s; the old safelyCloseClient invoked it immediately, so this child
    // died with a signal. The fixed version waits for the natural exit first.
    const config = stdioConfig({
      command: "node",
      args: [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), 3000));",
      ],
      env: {
        SYSTEMROOT: process.env.SystemRoot ?? "",
        PATH: process.env.PATH ?? "",
      },
      rootPath: process.cwd(),
    });
    const transport = createStdioTransport(config);
    await transport.start();
    const child = (
      transport as unknown as {
        _process: { exitCode: number | null; signalCode: string | null };
      }
    )._process;
    expect(child).toBeDefined();

    // Client stub whose close() runs the REAL SDK transport close (the kill ladder).
    const client = {
      transport,
      close: () => transport.close(),
    } as unknown as Client;
    await safelyCloseClient(client, "slow-teardown", undefined, {
      gracePeriodMs: 10000,
    });

    expect(child.signalCode).toBeNull(); // not SIGTERM/SIGKILLed
    expect(child.exitCode).toBe(0); // exited on its own terms
  }, 20000);

  it("skips the wait entirely when the child has already exited", async () => {
    const events: string[] = [];
    const child = new FakeChild();
    child.exitCode = 0; // already gone
    const client = clientWithChild(child, events);

    await safelyCloseClient(client, "wa-test", undefined, {
      gracePeriodMs: 10000,
    });

    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(events).toEqual(["client.close"]);
  });
});
