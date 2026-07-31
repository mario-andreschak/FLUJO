import {
  RIVER_SCENES,
  resolveRiverScene,
  type RiverSceneId,
} from '@/frontend/components/AmbientWorld/sceneMap';
import {
  cameraForScene,
  canvasPixelRatioForViewport,
  riverFillBottom,
} from '@/frontend/components/AmbientWorld/riverRenderer';
import { flowNodeColors } from '@/frontend/utils/flowPaletteTokens';

describe('Living Watershed scene map', () => {
  it.each<[string, RiverSceneId]>([
    ['/', 'home'],
    ['/models', 'models'],
    ['/mcp', 'mcp'],
    ['/flows', 'flows'],
    ['/chat', 'chat'],
    ['/automation/triggers', 'automations'],
    ['/executions', 'automations'],
    ['/automation/waves', 'waves'],
    ['/waves', 'waves'],
    ['/packages', 'packages'],
    ['/statistics', 'statistics'],
    ['/docs', 'docs'],
    ['/settings', 'settings'],
  ])('maps %s to the %s scene', (pathname, sceneId) => {
    expect(resolveRiverScene(pathname)).toBe(RIVER_SCENES[sceneId]);
  });

  it('keeps nested pages at their closest landmark', () => {
    expect(resolveRiverScene('/models/new')).toBe(RIVER_SCENES.models);
    expect(resolveRiverScene('/automation/triggers/next-run')).toBe(RIVER_SCENES.automations);
    expect(resolveRiverScene('/automation/waves/history')).toBe(RIVER_SCENES.waves);
    expect(resolveRiverScene('/docs/api/reference')).toBe(RIVER_SCENES.docs);
  });

  it('normalizes harmless pathname variations', () => {
    expect(resolveRiverScene('chat/')).toBe(RIVER_SCENES.chat);
    expect(resolveRiverScene('//packages///installed/?tab=updates#available')).toBe(RIVER_SCENES.packages);
  });

  it('falls back to the overlook for unknown or absent paths', () => {
    expect(resolveRiverScene('/not-a-real-place')).toBe(RIVER_SCENES.home);
    expect(resolveRiverScene('/modelsmith')).toBe(RIVER_SCENES.home);
    expect(resolveRiverScene(undefined)).toBe(RIVER_SCENES.home);
    expect(resolveRiverScene(null)).toBe(RIVER_SCENES.home);
  });

  it('provides complete, renderer-safe metadata for every scene', () => {
    const productAccents = new Set(Object.values(flowNodeColors).flatMap(Object.values));

    for (const [id, scene] of Object.entries(RIVER_SCENES)) {
      expect(scene.id).toBe(id);
      expect(scene.label).not.toHaveLength(0);
      expect(scene.eyebrow).not.toHaveLength(0);
      expect(scene.x).toBeGreaterThanOrEqual(0);
      expect(scene.x).toBeLessThanOrEqual(100);
      expect(scene.y).toBeGreaterThanOrEqual(0);
      expect(scene.y).toBeLessThanOrEqual(100);
      expect(scene.zoom).toBeGreaterThan(0);
      expect(scene.accent).toMatch(/^#[\da-f]{6}$/i);
      expect(productAccents).toContain(scene.accent);
      expect(scene.landmark).not.toHaveLength(0);
    }
  });
});


describe('Living Watershed viewport bounds', () => {
  it('caps a high-resolution canvas to a five-megapixel backing store', () => {
    const ratio = canvasPixelRatioForViewport(3840, 2160, 2);
    const pixelCount = Math.floor(3840 * ratio) * Math.floor(2160 * ratio);

    expect(ratio).toBeLessThan(1);
    expect(pixelCount).toBeLessThanOrEqual(5_000_000);
    expect(canvasPixelRatioForViewport(1440, 900, 2)).toBe(1.6);
  });

  it('extends terrain past the visible bottom of tall viewports', () => {
    const camera = cameraForScene(RIVER_SCENES.home);
    const pointer = { x: 0, y: -1 };
    const visibleWorldBottom = camera.y + (2160 * 0.51 + 8) / camera.zoom;

    expect(riverFillBottom(2160, camera, pointer)).toBeGreaterThan(visibleWorldBottom);
    expect(riverFillBottom(900, camera, { x: 0, y: 0 })).toBe(960);
  });
});
