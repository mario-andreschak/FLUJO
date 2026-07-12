import os from 'os';
import { execFile } from 'child_process';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/ollama/capability');

/** Best-effort detected GPU. Only NVIDIA (via nvidia-smi) is probed directly. */
export interface GpuInfo {
  vendor: 'nvidia' | 'apple';
  /** Total VRAM in bytes. For Apple Silicon this is unified memory (≈ system RAM). */
  vramBytes: number;
}

export interface HardwareCapability {
  totalRamBytes: number;
  cpuCores: number;
  platform: NodeJS.Platform;
  arch: string;
  gpu: GpuInfo | null;
  /** A model name sized for this hardware (see {@link suggestModel}). */
  suggestedModel: string;
}

const GB = 1024 * 1024 * 1024;

/**
 * Pick an Ollama model sized to the available memory. Pure so it can be tested.
 *
 * The binding constraint is the memory the model must fit in: a discrete GPU's
 * VRAM when present, otherwise system RAM (Apple Silicon reports its unified
 * memory as VRAM, which is why it flows through the same `vramBytes` path).
 * Thresholds are deliberately conservative — a suggestion, not a guarantee.
 */
export function suggestModel(input: { totalRamBytes: number; vramBytes?: number | null }): string {
  const ramGB = input.totalRamBytes / GB;
  const vramGB = input.vramBytes && input.vramBytes > 0 ? input.vramBytes / GB : 0;
  const effGB = vramGB > 0 ? vramGB : ramGB;

  if (effGB < 8) return 'llama3.2:1b';
  if (effGB < 16) return 'llama3.2:3b';
  if (effGB < 32) return 'qwen2.5:7b';
  return 'qwen2.5:14b';
}

/**
 * Best-effort NVIDIA VRAM probe via `nvidia-smi`. Returns total VRAM in bytes, or
 * null when there is no NVIDIA GPU / the tool is absent / it times out. Never
 * throws — GPU detection is optional and must not break the capability check.
 */
function detectNvidiaVramBytes(): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'nvidia-smi',
        ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
        { timeout: 2000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          // First GPU's total memory, reported in MiB.
          const firstLine = stdout.split('\n').map((l) => l.trim()).find(Boolean);
          const mib = firstLine ? Number.parseInt(firstLine, 10) : NaN;
          resolve(Number.isFinite(mib) && mib > 0 ? mib * 1024 * 1024 : null);
        }
      );
    } catch (e) {
      log.debug(`nvidia-smi probe threw: ${e instanceof Error ? e.message : String(e)}`);
      resolve(null);
    }
  });
}

async function detectGpu(): Promise<GpuInfo | null> {
  // Apple Silicon uses unified memory shared with the GPU, so treat system RAM as
  // available VRAM rather than probing (there is no nvidia-smi equivalent).
  if (os.platform() === 'darwin' && os.arch() === 'arm64') {
    return { vendor: 'apple', vramBytes: os.totalmem() };
  }
  const nvidia = await detectNvidiaVramBytes();
  return nvidia ? { vendor: 'nvidia', vramBytes: nvidia } : null;
}

/** Probe the local hardware and derive a suggested model. */
export async function probeCapability(): Promise<HardwareCapability> {
  const totalRamBytes = os.totalmem();
  const cpuCores = os.cpus().length;
  const gpu = await detectGpu();

  return {
    totalRamBytes,
    cpuCores,
    platform: os.platform(),
    arch: os.arch(),
    gpu,
    suggestedModel: suggestModel({ totalRamBytes, vramBytes: gpu?.vramBytes }),
  };
}
