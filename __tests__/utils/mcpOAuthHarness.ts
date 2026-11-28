/**
 * Drives FLUJO's MCP sign-in the way the app does, for tests against real authorization
 * servers: its routes (/api/oauth/initiate, /callback, /reset) answer in this process, a
 * headless "browser" follows redirects between the authorization server and those
 * routes, and connections use FLUJO's own client and transport factories.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { createNewClient, createTransport } from '@/backend/services/mcp/connection';
import { createBetaTransport, createNewBetaClient } from '@/backend/services/mcp/betaClient';
import { GET as callbackGET } from '@/app/api/oauth/callback/route';
import { POST as initiatePOST } from '@/app/api/oauth/initiate/route';
import { POST as resetPOST } from '@/app/api/oauth/reset/route';

export type ClientGeneration = 'v1' | 'v2';

/** A request to FLUJO at `origin`, answered by its route handlers in this process. */
export async function flujoRequest(origin: string, method: 'GET' | 'POST', route: string, body?: unknown): Promise<Response> {
  const url = new URL(route, origin);
  const request = new NextRequest(url, {
    method, headers: { host: url.host, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (url.pathname === '/api/oauth/initiate') return initiatePOST(request);
  if (url.pathname === '/api/oauth/reset') return resetPOST(request);
  if (url.pathname === '/api/oauth/callback') return callbackGET(request);
  throw new Error(`No route for ${url.pathname}`);
}

/** Follow redirects like a browser until FLUJO's MCP page; FLUJO's addresses go to its routes. */
export async function browse(start: string, origin: string): Promise<URL> {
  let current = new URL(start);
  for (let hop = 0; hop < 10; hop += 1) {
    if (current.origin === origin && current.pathname === '/mcp') return current;
    const response = current.origin === origin
      ? await flujoRequest(origin, 'GET', current.pathname + current.search)
      : await fetch(current, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      throw new Error(`${current.href} answered ${response.status}: ${await response.text()}`);
    }
    current = new URL(location, current);
  }
  throw new Error('Too many redirects');
}

export interface SignInResult {
  /** What /api/oauth/initiate answered. */
  initiate: { authorizationUrl?: string; alreadyAuthorized?: boolean; error?: string };
  /** FLUJO's MCP page the browser ended on, with oauth_success or oauth_error. */
  landing?: URL;
}

/** Select Authenticate, then let the browser follow the consent redirects. */
export async function signIn(name: string, origin: string): Promise<SignInResult> {
  const response = await flujoRequest(origin, 'POST', '/api/oauth/initiate', { serverName: name });
  const initiate = await response.json() as SignInResult['initiate'];
  if (!initiate.authorizationUrl) return { initiate };
  return { initiate, landing: await browse(initiate.authorizationUrl, origin) };
}

export async function storedConfig(name: string): Promise<MCPStreamableConfig> {
  const configs = await loadServerConfigs();
  if (!Array.isArray(configs)) throw new Error('MCP storage is unavailable');
  const found = configs.find((config) => config.name === name);
  if (!found || found.transport !== 'streamable') throw new Error(`${name} is not stored`);
  return found as MCPStreamableConfig;
}

export async function storeConfig(config: MCPStreamableConfig): Promise<void> {
  const configs = await loadServerConfigs();
  if (!Array.isArray(configs)) throw new Error('MCP storage is unavailable');
  const map = new Map(configs.map((item) => [item.name, item]));
  map.set(config.name, config);
  const saved = await saveConfig(map);
  if (!saved.success) throw new Error(`Could not store ${config.name}: ${saved.error}`);
}

export function streamableServer(name: string, serverUrl: string, extra: Partial<MCPStreamableConfig> = {}): MCPStreamableConfig {
  return { name, transport: 'streamable', serverUrl, rootPath: '', env: {}, disabled: false,
    _buildCommand: '', _installCommand: '', ...extra } as MCPStreamableConfig;
}

/** Connect the way MCPService does, with FLUJO's own client and transport factories. */
export async function connectWithFlujo(name: string, generation: ClientGeneration, opened: Client[]): Promise<Client> {
  const config = await storedConfig(name);
  const client = generation === 'v2' ? createNewBetaClient(config) : createNewClient(config);
  const transport = generation === 'v2' ? await createBetaTransport(config) : await createTransport(config);
  opened.push(client);
  await client.connect(transport as never);
  return client;
}

/** Everything written below `folder`, as one string. */
export async function everyStoredFile(folder: string): Promise<string> {
  const entries = await readdir(folder, { withFileTypes: true });
  const parts = await Promise.all(entries.map((entry) => {
    const full = path.join(folder, entry.name);
    return entry.isDirectory() ? everyStoredFile(full) : readFile(full, 'utf8');
  }));
  return parts.join('\n');
}
