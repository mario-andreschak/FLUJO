// Load only the three compiled geometry modules. The smoke process has no
// application, React, provider, MCP, storage or workspace dependencies.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(process.argv[2]);
const names = ['autoLayout', 'tidyLayout', 'layoutGeometry'];
const allowed = new Set(names.map((name) => path.join(root, `${name}.js`)));
const loaded = [];
const originalLoad = Module._load;
Module._load = function loadGeometryOnly(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (!allowed.has(resolved)) throw new Error(`Unexpected layout runtime dependency: ${request}`);
  loaded.push(path.basename(resolved));
  return originalLoad.call(this, request, parent, isMain);
};

const { computeAutoLayout } = require(path.join(root, 'autoLayout.js'));
const { computeTidyLayout } = require(path.join(root, 'tidyLayout.js'));
const { hasOverlaps } = require(path.join(root, 'layoutGeometry.js'));
const node = (id, type, x = 0, y = 0, measured) => ({
  id, type, position: { x, y }, data: { label: id, type, properties: { marker: id } },
  selected: id === 'selected', ...(measured ? { measured } : {}),
});
const edge = (source, target, edgeType = 'standard') => ({
  id: `${source}-${target}-${edgeType}`, source, target, data: { edgeType },
});
const fixtures = [
  { name: 'empty', nodes: [], edges: [] },
  { name: 'single', nodes: [node('selected', 'process', 7, 11)], edges: [] },
  { name: 'branch-with-satellites', nodes: [node('start', 'start'), node('a', 'process'), node('b', 'process'), node('m', 'mcp'), node('r', 'resource')], edges: [edge('start', 'a'), edge('start', 'b'), edge('a', 'm', 'mcp'), edge('r', 'b', 'resource')] },
  { name: 'cycle-and-measured-height', nodes: [node('a', 'process', 0, 0, { width: 210, height: 320 }), node('b', 'process'), node('m', 'mcp')], edges: [edge('a', 'b'), edge('b', 'a'), edge('b', 'm', 'mcp')] },
  { name: 'orphan-satellite', nodes: [node('start', 'start'), node('finish', 'finish'), node('orphan', 'mcp', -999, -999)], edges: [edge('start', 'finish')] },
  { name: 'already-separated', nodes: [node('start', 'start', 0, 0), node('finish', 'finish', 0, 800)], edges: [edge('start', 'finish')] },
];
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}
const started = process.hrtime.bigint();
const trace = fixtures.flatMap((fixture) => {
  freeze(fixture);
  return [['auto', computeAutoLayout], ['tidy', computeTidyLayout]].map(([mode, layout]) => {
    const result = layout(fixture.nodes, fixture.edges);
    assert.deepEqual(result.map(({ id }) => id), fixture.nodes.map(({ id }) => id));
    result.forEach((item, index) => {
      assert.equal(item.data, fixture.nodes[index].data);
      assert.equal(item.selected, fixture.nodes[index].selected);
      assert.ok(Number.isFinite(item.position.x) && Number.isFinite(item.position.y));
    });
    const overlaps = hasOverlaps(result);
    if (mode === 'auto') assert.equal(overlaps, false, `${fixture.name}/${mode} overlaps`);
    // Baseline tidy mode can retain overlaps for coincident satellites. Keep
    // that observation visible rather than claiming the extraction fixes it.
    return { fixture: fixture.name, mode, sameArray: result === fixture.nodes, overlaps, nodes: result };
  });
});
process.stdout.write(JSON.stringify({
  trace,
  loaded,
  measurements: {
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
  },
}));
