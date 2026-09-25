import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { computeDependencyRanks, initGraph, loadData, setFilter, clearFilters, applyPreset, getFilters, getCurrentPreset } from './graph.js';

const issues = ['start', 'parallel', 'middle', 'join', 'goal', 'unrelated'].map(id => ({ id }));
const dependencies = [
    { issue_id: 'middle', depends_on_id: 'start', type: 'blocks' },
    { issue_id: 'join', depends_on_id: 'middle', type: 'conditional-blocks' },
    { issue_id: 'join', depends_on_id: 'parallel', type: 'waits-for' },
    { issue_id: 'goal', depends_on_id: 'join' },
    { issue_id: 'goal', depends_on_id: 'start', type: 'blocks' },
    { issue_id: 'start', depends_on_id: 'goal', type: 'related' },
    { issue_id: 'unrelated', depends_on_id: 'goal', type: 'parent-child' },
];
const ranks = computeDependencyRanks(issues, dependencies);
assert.deepEqual(Object.fromEntries(ranks), { start: 0, parallel: 0, middle: 1, join: 2, goal: 3, unrelated: 0 });
assert.deepEqual(computeDependencyRanks(issues, [...dependencies, dependencies[0]]), ranks, 'duplicate edges do not change ranks');
assert.deepEqual(computeDependencyRanks([], []), new Map());
assert.equal(computeDependencyRanks([{ id: 'task' }], [{ issue_id: 'task', depends_on_id: 'missing' }]).get('task'), 1);
assert.throws(() => computeDependencyRanks(issues, [...dependencies, { issue_id: 'start', depends_on_id: 'goal' }]), /acyclic/);
assert.throws(() => computeDependencyRanks([{ id: 'self' }], [{ issue_id: 'self', depends_on_id: 'self' }]), /acyclic/);

// Check every edge in a large graph with multiple parents and skipped levels.
const large = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
const edges = large.slice(1).flatMap(({ id }) => [
    { issue_id: id, depends_on_id: String(Number(id) - 1) },
    { issue_id: id, depends_on_id: String(Math.floor(Number(id) / 2)) },
]);
const levels = computeDependencyRanks(large, edges);
for (const edge of edges) assert.ok(levels.get(edge.issue_id) > levels.get(edge.depends_on_id));
console.log('Dependency rank checks passed.');

// Exercise the real data and preset paths with a renderer that records its input.
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { getElementById: () => ({ innerHTML: '' }) });
globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
};
globalThis.d3 = createRequire(import.meta.url)('./vendor/d3.v7.min.js');
let data = { nodes: [], links: [] };
const properties = {};
const graph = new Proxy({}, {
    get: (_, key) => key === 'then' ? undefined : (...args) => {
        if (args.length) properties[key] = args[0];
        if (key === 'graphData') {
            if (!args.length) return data;
            data = args[0];
            for (const link of data.links) {
                link.source = data.nodes.find(node => node.id === link.source);
                link.target = data.nodes.find(node => node.id === link.target);
            }
        }
        return graph;
    }
});
globalThis.ForceGraph = () => () => graph;
await initGraph('graph');
const workflow = [
    { id: 'closed', status: 'closed' },
    { id: 'ready', status: 'open' },
    { id: 'next', status: 'open' },
    { id: 'done', status: 'tombstone' },
    { id: 'context', status: 'open' },
    { id: 'isolated', status: 'open' },
];
const chain = [
    { issue_id: 'ready', depends_on_id: 'closed', type: 'blocks' },
    { issue_id: 'next', depends_on_id: 'ready', type: 'blocks' },
    { issue_id: 'context', depends_on_id: 'next', type: 'related' },
];
const node = id => data.nodes.find(node => node.id === id);
loadData(workflow, chain);
assert.deepEqual(data.nodes.map(node => node.id), ['ready', 'next']);
assert.equal(workflow.length, 6, 'graph filtering preserves the source issue list');
assert.equal(node('ready').dependencyRank, 0);
assert.equal(node('next').dependencyRank, 1);
assert.ok(node('ready').x < node('next').x);
assert.equal(node('ready').x, node('ready').fx);
assert.equal(properties.autoPauseRedraw, false, 'particles keep moving after the layout stops');
const originalNow = performance.now;
const circles = [];
const ctx = new Proxy({}, { get: (_, key) => key === 'arc' ? (...args) => circles.push(args) : () => {} });
try {
    performance.now = () => 500;
    properties.linkCanvasObject(data.links[0], ctx, 1);
    assert.equal(circles.length, 2);
    const firstX = circles[0][0];
    circles.length = 0;
    performance.now = () => 1000;
    properties.linkCanvasObject(data.links[0], ctx, 1);
    assert.ok(circles[0][0] > firstX, 'particles move from the blocker toward its dependent');
    assert.ok(circles.every(([x, y]) => x > node('ready').x && x < node('next').x && y === node('ready').y));
} finally {
    performance.now = originalNow;
}
setFilter('showClosed', true);
assert.deepEqual(data.nodes.map(node => node.id), ['closed', 'ready', 'next'], 'context links and absent links do not connect beads');
assert.equal(node('ready').dependencyRank, 1);
assert.equal(node('next').dependencyRank, 2);
setFilter('showClosed', false);
assert.equal(node('ready').dependencyRank, 0, 'hiding closed beads recomputes levels');
setFilter('search', 'next');
assert.equal(data.nodes.length, 1);
assert.equal(node('next').dependencyRank, 1, 'search cannot turn a blocked task into a root');
clearFilters();
assert.equal(getFilters().showClosed, false);
assert.equal(data.nodes.length, 2);
assert.ok(applyPreset('force'));
assert.ok(data.nodes.every(node => node.fx === null && node.fy === null));
assert.equal(properties.linkDirectionalParticles(), 2, 'force layouts retain their native particles');
assert.ok(applyPreset('dependencies'));
assert.ok(data.nodes.every(node => Number.isFinite(node.fx) && node.fx === node.x));
setFilter('search', 'no match');
assert.deepEqual(data, { nodes: [], links: [] });
clearFilters();
assert.ok(node('ready').x < node('next').x);

loadData([
    { id: 'root-a', status: 'open' },
    { id: 'root-b', status: 'open' },
    { id: 'join', status: 'open' },
], [
    { issue_id: 'join', depends_on_id: 'root-a' },
    { issue_id: 'join', depends_on_id: 'root-b' },
]);
assert.equal(node('root-a').x, node('root-b').x, 'parallel roots align in one column');
assert.notEqual(node('root-a').y, node('root-b').y, 'parallel roots do not overlap');
assert.ok(node('join').x > node('root-a').x);

loadData([{ id: 'a', status: 'open' }, { id: 'b', status: 'closed' }], [
    { issue_id: 'a', depends_on_id: 'b' },
    { issue_id: 'b', depends_on_id: 'a' },
]);
setFilter('showClosed', true);
assert.equal(getFilters().showClosed, false, 'an invalid cyclic layout preserves the previous filter');
assert.deepEqual(data.nodes.map(node => node.id), ['a']);
loadData([{ id: 'a', status: 'open' }, { id: 'b', status: 'open' }], [
    { issue_id: 'a', depends_on_id: 'b' },
    { issue_id: 'b', depends_on_id: 'a' },
]);
assert.equal(getCurrentPreset(), 'force', 'a cyclic data reload restores the force layout');
assert.ok(data.nodes.every(node => node.fx === null && node.fy === null));
assert.equal(properties.enableNodeDrag, true);
assert.ok(properties.cooldownTicks > 0);
assert.equal(properties.linkDirectionalParticles(), 2);
console.log('Closed filters, search, empty graphs, and preset switches passed.');
