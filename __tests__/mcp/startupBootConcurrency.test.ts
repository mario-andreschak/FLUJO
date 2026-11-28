/**
 * The startup sweep connects several MCP servers at once, as many as the
 * machine allows (#1449). It replaced the FLUJO_MCP_BOOT_CONCURRENCY variable.
 */
import { bootConcurrency } from '@/backend/services/mcp/connectionScheduling';

const GiB = 1024 ** 3;

describe('MCP startup sweep size', () => {
  it('keeps two at once on a small machine, as before', () => {
    expect(bootConcurrency(1, 2 * GiB)).toBe(2);
    expect(bootConcurrency(2, 1 * GiB)).toBe(2);
  });

  it('grows with processors and memory, whichever is smaller', () => {
    expect(bootConcurrency(8, 16 * GiB)).toBe(4);
    expect(bootConcurrency(16, 6 * GiB)).toBe(3);
  });

  it('never starts more than eight servers at once', () => {
    expect(bootConcurrency(64, 256 * GiB)).toBe(8);
  });

  it('reads this machine when called without arguments', () => {
    const size = bootConcurrency();
    expect(size).toBeGreaterThanOrEqual(2);
    expect(size).toBeLessThanOrEqual(8);
  });
});
