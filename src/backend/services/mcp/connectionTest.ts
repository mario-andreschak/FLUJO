// Tests an MCP server config without registering it: a throwaway client, live output and a classic-handshake retry.
import { assertBundledFlujoWorkloadEffectCurrent, BundledFlujoWorkloadError } from '../security/bundledFlujoWorkload';
import { executionApprovalFailure } from './executionApproval';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StringDecoder } from "node:string_decoder";
import { collectMcpDiagnosticSecrets, createMcpDiagnosticRedactor } from "@/utils/mcp/diagnosticRedaction";
import { createLogger } from "@/utils/logger";
import { isProtectedExecutionServer } from '@/backend/execution/extensions';
import { isMcpTransport, MCP_TRANSPORT_INVALID } from './transportAdmission';
import { MCPServerConfig, MCPStreamableConfig, MCPSSEConfig, MCPServiceResponse } from "@/shared/types/mcp";
import { TestConnectionEvent } from "@/shared/types/streaming";
import { resolveRuntimeHomeIsolation } from "./runtimeHomeIsolation";
import { noteStdioConnectFailure, takeClassicHandshakeRetry } from "./stdioNegotiation";
import { enhanceConnectionErrorMessage, formatErrorChain, isAuthRequiredError } from "@/utils/mcp/utils";
import { hydrateMaskedHeaders } from "@/utils/mcp/headers";
import { hasMaskedStoredHeaders, isSameMcpHeaderDestination, MCP_HEADER_DESTINATION_CHANGED } from "@/utils/mcp/headerDestination";
import {
  getTestConnectionTimeoutMs,
  isRunnerStdioConfig,
} from "@/utils/mcp/testConnectionTimeout";
import { probeOAuthSupport } from "@/utils/mcp/oauthProbe";
import {
  createNewClient,
  createTransport,
  resolveConfigHeaders,
  safelyCloseClient,
  McpRuntimeAuthorityRetirementError,
  assertMcpRuntimeAuthorityRetired,
} from "./connection";
import {
  isMcpBetaProtocolEnabled,
  createNewBetaClient,
  createBetaTransport,
  activateStdioOAuthMrtrController,
  getStdioOAuthMrtrController,
} from "./betaClient";
import { registerExternalAuthorizationClient } from "./externalAuthorization";
import { transportForHostInspection } from './transportInspection';

const log = createLogger('backend/services/mcp/connectionTest');

/** What the connection test reads from the MCP service. */
export type ConnectionTestHost = {
  loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse>;
};

const RETRY_WITH_CLASSIC_HANDSHAKE = Symbol("retry with the classic MCP handshake");

/**
 * Test a connection to an MCP server WITHOUT registering it as a managed client.
 *
 * This performs a real MCP handshake (and tool listing) using the same transport,
 * TLS trust and custom headers the running server would use. It is the backend
 * counterpart of the modal's "Test Run" button: because it runs in the Next.js
 * server process (not the browser), it can reach servers behind custom CAs and send
 * the configured Authorization/X-SAP-* headers, which a browser fetch cannot.
 */
export async function testConnection(
  host: ConnectionTestHost,
  config: MCPServerConfig,
  onOutput?: (event: TestConnectionEvent) => void,
  options?: { storedName?: string },
): Promise<MCPServiceResponse> {
  const result = await testConnectionAttempt(host, config, onOutput, options);
  if (result !== RETRY_WITH_CLASSIC_HANDSHAKE) return result;
  const retried = await testConnectionAttempt(host, config, onOutput, options);
  return retried === RETRY_WITH_CLASSIC_HANDSHAKE ? { success: false, error: "MCP server quit during startup." } : retried;
}

async function testConnectionAttempt(
  host: ConnectionTestHost,
  config: MCPServerConfig,
  onOutput?: (event: TestConnectionEvent) => void,
  options?: { storedName?: string },
): Promise<MCPServiceResponse | typeof RETRY_WITH_CLASSIC_HANDSHAKE> {
  if (!isMcpTransport(config.transport)) {
    return { success: false, error: MCP_TRANSPORT_INVALID, statusCode: 400 };
  }
  log.info(
    `testConnection: Testing connection to ${config.name || "(unnamed)"} via ${config.transport} transport`,
  );

  // Optional live-output sink (issue #64). When omitted, behaviour is byte-for-byte
  // identical to the original one-shot request/response probe.
  const emit = (event: TestConnectionEvent): void => {
    try {
      onOutput?.(event);
    } catch {
      // A misbehaving sink must never break the probe itself.
    }
  };

  const stderrLogs: string[] = [];
  let diagnosticRedactor = createMcpDiagnosticRedactor(collectMcpDiagnosticSecrets(config, config));
  let stderrRedactor = diagnosticRedactor.stream();
  const stderrDecoder = new StringDecoder("utf8");
  let diagnosticsFinished = false;
  const appendStderr = (chunk: string) => {
    if (!chunk) return;
    stderrLogs.push(chunk);
    emit({ type: "stderr", data: chunk });
  };
  const finishDiagnostics = () => {
    if (diagnosticsFinished) return;
    diagnosticsFinished = true;
    appendStderr(stderrRedactor.write(stderrDecoder.end()));
    appendStderr(stderrRedactor.end());
  };
  let client: Client | null = null;
  let transport:
    | Awaited<ReturnType<typeof createTransport>>
    | Awaited<ReturnType<typeof createBetaTransport>>
    | null = null;

  try {
    // For remote (streamable/sse) servers the browser may send back a MASKED secret header
    // (e.g. Authorization: "********") when the user did not re-type the token — i.e. when
    // editing or re-testing a server whose secret was saved earlier (#137). Hydrate those
    // masked SECRET headers from the stored, saved config (looked up by the pre-edit name so
    // rename + Test Connection also works) before resolving, mirroring resolveHeadersForSave's
    // masked->keep contract. This happens entirely server-side — the real secret is read from
    // disk here and never sent to the browser. resolveConfigHeaders then decrypts/resolves it
    // exactly as the live connection does.
    let toTest = config;
    const lookupName = options?.storedName || config.name;
    if (
      (config.transport === "streamable" || config.transport === "sse") &&
      lookupName
    ) {
      const stored = await host.loadServerConfigs();
      const savedCfg = Array.isArray(stored)
        ? stored.find((c) => c.name === lookupName)
        : undefined;
      const savedHeaders = (
        savedCfg as MCPSSEConfig | MCPStreamableConfig | undefined
      )?.headers;
      const incomingHeaders = (config as MCPSSEConfig | MCPStreamableConfig)
        .headers;
      if (
        hasMaskedStoredHeaders(incomingHeaders, savedHeaders) &&
        !isSameMcpHeaderDestination(config, savedCfg)
      ) {
        emit({ type: "result", success: false, error: MCP_HEADER_DESTINATION_CHANGED });
        return { success: false, error: MCP_HEADER_DESTINATION_CHANGED, statusCode: 400 };
      }
      toTest = {
        ...config,
        headers: hydrateMaskedHeaders(incomingHeaders, savedHeaders),
      } as MCPServerConfig;
    }

    // Resolve + decrypt custom headers (#84) so the probe uses the same real header values
    // the live connection would (shares createTransport). Global bindings / encrypted
    // secrets are resolved here; plain values pass through unchanged.
    const connectConfig = await resolveConfigHeaders(toTest);
    await assertBundledFlujoWorkloadEffectCurrent();
    assertMcpRuntimeAuthorityRetired(connectConfig.name);
    diagnosticRedactor = createMcpDiagnosticRedactor(collectMcpDiagnosticSecrets(toTest, connectConfig));
    stderrRedactor = diagnosticRedactor.stream();
    // Same experimental v2-beta routing as the live connection, so Test Run
    // probes exactly what connectServer would build.
    const useBeta =
      !isProtectedExecutionServer(connectConfig.name) && (await isMcpBetaProtocolEnabled()) &&
      connectConfig.transport !== "websocket";
    const isolateRuntimeHome = await resolveRuntimeHomeIsolation(connectConfig);
    const transportOptions = { isolateRuntimeHome };
    client = useBeta
      ? createNewBetaClient(connectConfig)
      : createNewClient(connectConfig);
    transport = useBeta
      ? await createBetaTransport(connectConfig, transportOptions)
      : await createTransport(connectConfig, transportOptions);
    if (connectConfig.transport === "stdio") {
      registerExternalAuthorizationClient(
        client,
        connectConfig.name,
        useBeta ? getStdioOAuthMrtrController(transport) : undefined,
      );
    }

    // Capture stdio stderr (for stdio servers) and transport errors so we can build a
    // meaningful message if the handshake fails. When a live-output sink is attached
    // (issue #64), also forward each chunk AS IT ARRIVES so a slow cold `npx`/`uvx`
    // start fills the console instead of looking frozen. (The child's stdout is the
    // MCP JSON-RPC channel owned by the SDK transport, so only stderr + lifecycle
    // markers are reliably streamable for stdio.) Duck-typed on the stderr stream so
    // the v2-beta stdio transport is covered too.
    const probeStderr = (
      transportForHostInspection(transport) as {
        stderr?: NodeJS.ReadableStream | null;
      }
    ).stderr;
    if (probeStderr && typeof probeStderr.on === "function") {
      probeStderr.on("data", (data: Buffer) => {
        if (!diagnosticsFinished) appendStderr(stderrRedactor.write(stderrDecoder.write(data)));
      });
    }
    transport.onerror = (err: Error) => {
      if (!diagnosticsFinished) appendStderr(diagnosticRedactor.redact(`Transport error: ${formatErrorChain(err)}\n`));
    };

    emit({
      type: "status",
      phase: "spawning",
      message: "Starting server / opening transport...",
    });

    // Runner-aware timeout: a cold `npx`/`uvx`/`bunx`/`pnpm dlx` may need to DOWNLOAD
    // the package before the MCP handshake even starts, which routinely exceeds the 15s
    // default (issue #43). Local commands and HTTP transports keep the 15s default.
    const timeoutMs = getTestConnectionTimeoutMs(config);
    const isRunner = isRunnerStdioConfig(config);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            new Error(
              `Connection timeout after ${timeoutMs / 1000}s` +
                (isRunner
                  ? " — the package may still be downloading via npx/uvx. Try running the Test again (the package is cached after the first download), or verify the command and network access."
                  : ""),
            ),
          ),
        timeoutMs,
      );
    });

    emit({
      type: "status",
      phase: "handshaking",
      message: "Performing MCP handshake...",
    });
    try {
      await assertBundledFlujoWorkloadEffectCurrent();
      await Promise.race([client.connect(transport, { timeout: timeoutMs }), timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    if (connectConfig.transport === "stdio" && useBeta) {
      activateStdioOAuthMrtrController(transport);
    }

    // Handshake succeeded — try to list tools to confirm full protocol compatibility.
    emit({
      type: "status",
      phase: "listing-tools",
      message: "Handshake OK — listing tools...",
    });
    let toolCount = 0;
    try {
      const result = await client.listTools();
      toolCount = Array.isArray(result?.tools) ? result.tools.length : 0;
    } catch (listError) {
        if (listError instanceof BundledFlujoWorkloadError) throw listError;
      log.debug(
        `testConnection: connected to ${config.name} but listTools failed: ${diagnosticRedactor.redact(formatErrorChain(listError))}`,
      );
    }

    log.info(
      `testConnection: Successfully connected to ${config.name} (${toolCount} tools)`,
    );
    finishDiagnostics();
    emit({ type: "result", success: true, data: { toolCount } });
    return { success: true, data: { toolCount } };
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
    finishDiagnostics();
    if (config.transport === "stdio") {
      noteStdioConnectFailure(config, error);
      if (takeClassicHandshakeRetry(config.name)) return RETRY_WITH_CLASSIC_HANDSHAKE;
    }
    const approvalFailure = executionApprovalFailure(error);
    if (approvalFailure) {
      emit({ type: 'result', success: false, error: approvalFailure.error });
      return approvalFailure;
    }
    log.warn(`testConnection: Failed to connect to ${config.name}:`, diagnosticRedactor.redact(formatErrorChain(error)));

    const requiresAuthentication = isAuthRequiredError(error);

    // When a remote server rejects the probe for auth, find out WHETHER it speaks OAuth
    // (RFC 9728) so the UI can offer to authenticate instead of only hinting at a static
    // Authorization header. Best-effort: probeOAuthSupport never throws.
    let oauthCapable: boolean | undefined;
    if (
      requiresAuthentication &&
      (config.transport === "streamable" || config.transport === "sse")
    ) {
      const serverUrl = (config as MCPStreamableConfig | MCPSSEConfig)
        .serverUrl;
      if (serverUrl) {
        oauthCapable = (await probeOAuthSupport(serverUrl)).oauthCapable;
      }
    }

    const enhancedErrorMessage = await enhanceConnectionErrorMessage(
      error,
      config,
      stderrLogs.length ? [stderrLogs.join("")] : [],
      diagnosticRedactor.redact,
    );
    emit({
      type: "result",
      success: false,
      error: enhancedErrorMessage,
      requiresAuthentication,
      oauthCapable,
    });
    return {
      success: false,
      error: enhancedErrorMessage,
      requiresAuthentication,
      oauthCapable,
    };
  } finally {
    if (client) {
      try {
        // Short grace: this is a throwaway probe and the Test Run response is
        // waiting on this close - don't hold it for the full production window.
        await safelyCloseClient(client, config.name, config, {
          gracePeriodMs: 3000,
          killEscalationMs: 2000,
        });
      } catch (closeError) {
        if (closeError instanceof McpRuntimeAuthorityRetirementError || closeError instanceof BundledFlujoWorkloadError) throw closeError;
        log.debug(
          `testConnection: error closing test client for ${config.name}: ${diagnosticRedactor.redact(formatErrorChain(closeError))}`,
        );
      }
    }
  }
}

/**
 * Register (or clear, when `roots` is empty) the workspace-folder overlay a FlowBuilder
 * MCP node contributes to its bound server (issue 46). Connections are singletons keyed
 * by server name, so node roots are additive: roots/list answers with the union of the
 * server-level roots and all currently-registered node roots (falling back to the
 * server's rootPath when there are none at all). The roots capability is always
 * declared, so this NEVER rebuilds a connection — servers whose effective roots
 * changed are told via notifications/roots/list_changed instead.
 */
