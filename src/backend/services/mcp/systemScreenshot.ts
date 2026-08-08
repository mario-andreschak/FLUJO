/**
 * `system_screenshot` — a host-desktop screenshot tool for the internal FLUJO
 * MCP server.
 *
 * Explicitly unrelated to the `browser` MCP package: this captures whatever is
 * on the physical/virtual desktop of the machine FLUJO runs on (any window,
 * any app), not a rendered page. Per owner direction on issue #366, this is a
 * debugging/observation aid and is default-OFF behind an env kill-switch,
 * since it is a genuinely new capability class (it can capture password
 * managers, other users' windows, unrelated applications).
 *
 * Implementation is OS-native commands only — no new npm dependency, no
 * Electron `desktopCapturer`:
 *  - Windows: PowerShell + `System.Drawing`/`System.Windows.Forms`, a single
 *    static script invoked with parameters passed through environment
 *    variables (never string-interpolated into the script text).
 *  - macOS: `/usr/sbin/screencapture`, argv array only.
 *  - Linux: probe `grim` (Wayland) → `import` (X11/ImageMagick) →
 *    `spectacle`/`gnome-screenshot` (fullscreen-only fallbacks), argv array
 *    only.
 *
 * All spawns use argv arrays (never a shell string), so no caller-controlled
 * value can ever be interpreted as shell syntax. This is intentionally
 * independent from the `bash` MCP server and must not grow into a general
 * command-execution path.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { getWorkspaceDataDir } from '@/utils/workspace';

const SPAWN_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 30_000_000;

function truthyEnv(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? '');
}

/** `system_screenshot` is advertised only when the operator opted in. */
export function systemScreenshotEnabled(): boolean {
  return truthyEnv('FLUJO_SYSTEM_SCREENSHOT_ENABLED');
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function screenshotRoot(): string {
  return path.resolve(getWorkspaceDataDir(), 'screenshots', 'system');
}

async function realpathIfExists(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function resolveOutputPath(outputPath: unknown): Promise<string> {
  const root = screenshotRoot();
  if (typeof outputPath === 'string' && outputPath.trim().length > 0) {
    const resolved = path.resolve(outputPath.trim());
    const real = await realpathIfExists(path.dirname(resolved));
    const dataDir = await realpathIfExists(getWorkspaceDataDir());
    if (!isInside(root, resolved) && !isInside(dataDir, real) && !isInside(dataDir, resolved)) {
      throw new Error('outputPath must be inside the FLUJO data directory.');
    }
    return resolved;
  }
  return path.join(root, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
}

/**
 * Best-effort guard against capturing a non-interactive session: headless
 * Linux with no `DISPLAY`/`WAYLAND_DISPLAY`, or a Windows service running in
 * session 0 (no `SESSIONNAME`). This cannot be perfect from Node alone, but it
 * catches the exact failure mode #366 documents (automation running headless).
 */
function hasInteractiveDesktopSession(): boolean {
  if (process.platform === 'linux') {
    return Boolean(process.env.DISPLAY?.trim() || process.env.WAYLAND_DISPLAY?.trim());
  }
  if (process.platform === 'win32') {
    return Boolean(process.env.SESSIONNAME?.trim());
  }
  return true;
}

function runSpawn(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', env: env ?? process.env, windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out.`));
    }, SPAWN_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await runSpawn(probe, [command]);
    return true;
  } catch {
    return false;
  }
}

type CaptureRequest = {
  mode: 'fullscreen' | 'display' | 'region';
  display?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  outputPath: string;
};

/**
 * Fixed PowerShell script. Every caller-controlled value flows through
 * environment variables (`FLUJO_CAPTURE_*`), never into the script text, so
 * there is no way for a call's arguments to change what code executes.
 */
const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$mode = $env:FLUJO_CAPTURE_MODE
$out = $env:FLUJO_CAPTURE_OUT
$bounds = $null
if ($mode -eq 'region') {
  $x = [int]$env:FLUJO_CAPTURE_X
  $y = [int]$env:FLUJO_CAPTURE_Y
  $w = [int]$env:FLUJO_CAPTURE_W
  $h = [int]$env:FLUJO_CAPTURE_H
  $bounds = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
} elseif ($mode -eq 'display') {
  $idx = [int]$env:FLUJO_CAPTURE_DISPLAY
  $screens = [System.Windows.Forms.Screen]::AllScreens
  if ($idx -lt 0 -or $idx -ge $screens.Length) { Write-Error "Display index out of range"; exit 2 }
  $bounds = $screens[$idx].Bounds
} else {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
}
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::new(0, 0), $bounds.Size)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bmp.Dispose()
}
`;

async function captureWindows(req: CaptureRequest): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLUJO_CAPTURE_MODE: req.mode,
    FLUJO_CAPTURE_OUT: req.outputPath,
    FLUJO_CAPTURE_DISPLAY: String(req.display ?? 0),
    FLUJO_CAPTURE_X: String(req.x ?? 0),
    FLUJO_CAPTURE_Y: String(req.y ?? 0),
    FLUJO_CAPTURE_W: String(req.width ?? 0),
    FLUJO_CAPTURE_H: String(req.height ?? 0),
  };
  await runSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], env);
}

async function captureMacOs(req: CaptureRequest): Promise<void> {
  const args = ['-x', '-t', 'png'];
  if (req.mode === 'region') {
    args.push('-R', `${req.x ?? 0},${req.y ?? 0},${req.width ?? 0},${req.height ?? 0}`);
  } else if (req.mode === 'display') {
    args.push('-D', String((req.display ?? 0) + 1));
  }
  args.push(req.outputPath);
  await runSpawn('/usr/sbin/screencapture', args);
}

async function captureLinux(req: CaptureRequest): Promise<void> {
  if (await commandExists('grim')) {
    const args: string[] = [];
    if (req.mode === 'region') {
      args.push('-g', `${req.x ?? 0},${req.y ?? 0} ${req.width ?? 0}x${req.height ?? 0}`);
    } else if (req.mode === 'display') {
      args.push('-o', `display-${req.display ?? 0}`);
    }
    args.push(req.outputPath);
    await runSpawn('grim', args);
    return;
  }
  if (await commandExists('import')) {
    const args = ['-window', 'root'];
    if (req.mode === 'region') {
      args.push('-crop', `${req.width ?? 0}x${req.height ?? 0}+${req.x ?? 0}+${req.y ?? 0}`, '+repage');
    }
    args.push(req.outputPath);
    await runSpawn('import', args);
    return;
  }
  if (req.mode === 'region') {
    throw new Error('No available capture backend supports region capture on this system (tried grim, import).');
  }
  if (await commandExists('spectacle')) {
    await runSpawn('spectacle', ['-b', '-n', '-f', '-o', req.outputPath]);
    return;
  }
  if (await commandExists('gnome-screenshot')) {
    await runSpawn('gnome-screenshot', ['-f', req.outputPath]);
    return;
  }
  throw new Error(
    'No screenshot backend was found. Install one of: grim (Wayland), ImageMagick (import), spectacle, or gnome-screenshot.',
  );
}

async function captureDesktop(req: CaptureRequest): Promise<void> {
  await fs.mkdir(path.dirname(req.outputPath), { recursive: true });
  if (process.platform === 'win32') return captureWindows(req);
  if (process.platform === 'darwin') return captureMacOs(req);
  if (process.platform === 'linux') return captureLinux(req);
  throw new Error(`system_screenshot is not supported on platform "${process.platform}".`);
}

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

export function systemScreenshotToolDefinition(): Tool | undefined {
  if (!systemScreenshotEnabled()) return undefined;
  return {
    name: 'system_screenshot',
    description:
      "Capture a screenshot of the host desktop (full virtual screen, a specific display, or a pixel region). This captures whatever is visible on the machine FLUJO runs on, including unrelated windows and applications -- it is a debugging/observation aid, NOT a way to verify rendered HTML (use the browser MCP server's browser_capture_page for that). Disabled unless the operator enables FLUJO_SYSTEM_SCREENSHOT_ENABLED.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['fullscreen', 'display', 'region'],
          description: 'Capture mode (default fullscreen).',
        },
        display: {
          type: 'integer',
          minimum: 0,
          maximum: 31,
          description: 'Zero-based display index, used with mode "display".',
        },
        x: { type: 'integer', description: 'Region left edge in pixels, required for mode "region".' },
        y: { type: 'integer', description: 'Region top edge in pixels, required for mode "region".' },
        width: { type: 'integer', minimum: 1, description: 'Region width in pixels, required for mode "region".' },
        height: { type: 'integer', minimum: 1, description: 'Region height in pixels, required for mode "region".' },
        outputPath: {
          type: 'string',
          description: 'Optional destination PNG path, confined to the FLUJO data directory.',
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  };
}

export async function systemScreenshotHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  if (!systemScreenshotEnabled()) {
    return textResult({ error: 'system_screenshot is disabled by policy (set FLUJO_SYSTEM_SCREENSHOT_ENABLED=1 to enable).' }, true);
  }
  if (!hasInteractiveDesktopSession()) {
    return textResult({ error: 'No interactive desktop session was detected on this host; system_screenshot cannot run headless.' }, true);
  }

  const mode = args?.mode === 'display' || args?.mode === 'region' ? args.mode : 'fullscreen';
  const display = typeof args?.display === 'number' && Number.isInteger(args.display) ? args.display : undefined;
  const x = typeof args?.x === 'number' ? Math.trunc(args.x) : undefined;
  const y = typeof args?.y === 'number' ? Math.trunc(args.y) : undefined;
  const width = typeof args?.width === 'number' ? Math.trunc(args.width) : undefined;
  const height = typeof args?.height === 'number' ? Math.trunc(args.height) : undefined;

  if (mode === 'display' && (display === undefined || display < 0)) {
    return textResult({ error: 'mode "display" requires a non-negative integer "display" index.' }, true);
  }
  if (mode === 'region' && (x === undefined || y === undefined || !width || !height || width < 1 || height < 1 || x < 0 || y < 0)) {
    return textResult({ error: 'mode "region" requires non-negative x, y and positive width, height.' }, true);
  }

  let outputPath: string;
  try {
    outputPath = await resolveOutputPath(args?.outputPath);
  } catch (error) {
    return textResult({ error: error instanceof Error ? error.message : 'Invalid outputPath.' }, true);
  }

  try {
    await captureDesktop({ mode, display, x, y, width, height, outputPath });
  } catch (error) {
    return textResult({ error: error instanceof Error ? error.message : 'The desktop screenshot failed.' }, true);
  }

  let png: Buffer;
  try {
    png = await fs.readFile(outputPath);
  } catch {
    return textResult({ error: 'The screenshot backend did not produce an output file.' }, true);
  }
  if (png.length === 0 || png.length > MAX_IMAGE_BYTES) {
    return textResult({ error: 'The captured screenshot had an invalid size.' }, true);
  }

  const sha256 = createHash('sha256').update(png).digest('hex');
  const data = {
    success: true,
    mode,
    display: mode === 'display' ? display : undefined,
    region: mode === 'region' ? { x, y, width, height } : undefined,
    path: outputPath,
    mimeType: 'image/png',
    bytes: png.length,
    sha256,
  };
  return {
    content: [
      { type: 'text', text: JSON.stringify(data) },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ],
    structuredContent: data,
  };
}
