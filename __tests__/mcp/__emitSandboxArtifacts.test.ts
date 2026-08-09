import fs from 'node:fs';
import path from 'node:path';
import { buildSandboxProxyHtml, buildSandboxProxyCsp } from '@/backend/mcpApps/sandboxServer';

const HOST_ORIGIN = process.env.HARNESS_HOST_ORIGIN || 'http://127.0.0.1:45510';
const OUT = process.env.HARNESS_OUT_DIR || path.join(process.cwd(), '.tmp-sandbox-harness');
const SHOULD_CLEAN_OUT = !process.env.HARNESS_OUT_DIR;

afterAll(() => {
  if (SHOULD_CLEAN_OUT) {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
});

it('emits the real sandbox proxy document for the browser harness', () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'sandbox.html'), buildSandboxProxyHtml([], false, undefined));
  fs.writeFileSync(path.join(OUT, 'sandbox.csp.txt'), buildSandboxProxyCsp(HOST_ORIGIN, undefined));
  expect(fs.existsSync(path.join(OUT, 'sandbox.html'))).toBe(true);
});