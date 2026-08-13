import path from 'node:path';
import { normalizeResolution, resolutionFallbacks, resolveCaptureSource } from '../../mcp-servers/browser/src/capture';

describe('forgiving browser parameters', () => {
  const options = {
    defaultValue: { width: 1280, height: 720 },
    minWidth: 320,
    minHeight: 240,
    maxWidth: 1920,
    maxHeight: 1080,
    even: true,
  };

  it('accepts presets, WIDTHxHEIGHT, numeric legacy strings, and safe resolution downgrades', () => {
    expect(normalizeResolution('720p', undefined, undefined, options)).toMatchObject({
      requested: { width: 1280, height: 720 },
      effective: { width: 1280, height: 720 },
      warnings: [],
    });
    expect(normalizeResolution('1601x901', undefined, undefined, options)).toMatchObject({
      requested: { width: 1601, height: 901 },
      effective: { width: 1600, height: 900 },
    });
    expect(normalizeResolution('4k', undefined, undefined, options)).toMatchObject({
      requested: { width: 3840, height: 2160 },
      effective: { width: 1920, height: 1080 },
    });
    expect(normalizeResolution(undefined, '1024', '768', options).effective).toEqual({ width: 1024, height: 768 });
  });

  it('falls back from invalid values and supplies unique recovery resolutions', () => {
    const normalized = normalizeResolution('enormous please', undefined, undefined, options);
    expect(normalized.effective).toEqual({ width: 1280, height: 720 });
    expect(normalized.warnings[0]).toContain('Unrecognized resolution');
    expect(resolutionFallbacks({ width: 1920, height: 1080 })).toEqual([
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 854, height: 480 },
      { width: 640, height: 360 },
    ]);
  });

  it('uses one compact source for remote, localhost, file, and HTML captures without policy flags', async () => {
    await expect(resolveCaptureSource({ source: 'localhost:4200' })).resolves.toMatchObject({
      kind: 'url', url: 'http://localhost:4200/',
    });
    await expect(resolveCaptureSource({ source: path.resolve('package.json') })).resolves.toMatchObject({
      kind: 'url', url: expect.stringMatching(/^file:/),
    });
    await expect(resolveCaptureSource({ source: '<h1>hello</h1>' })).resolves.toEqual({
      kind: 'html', html: '<h1>hello</h1>', warnings: [],
    });
    const multiple = await resolveCaptureSource({ source: 'example.com', url: 'https://ignored.example' });
    expect(multiple).toMatchObject({ kind: 'url', url: 'https://example.com/' });
    expect(multiple.warnings).toHaveLength(1);
  });
});
