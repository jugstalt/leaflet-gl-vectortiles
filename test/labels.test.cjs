'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./helpers/load.cjs');

const { plugin, shared } = load();
const { symbolAnchors, iconInTile } = shared;
const { placeAlongPath } = plugin._internals;

const identity = { tx: p => p[0], ty: p => p[1] };
const anchors = (feature, placement, spacing, keepViewport) =>
    plain(symbolAnchors(feature, placement, spacing, keepViewport, identity.tx, identity.ty));

test('point placement: every point of a point feature', () => {
    const a = anchors({ type: 'Point', geometry: [[[10, 20]], [[30, 40]]] }, 'point', 0, false);
    assert.deepEqual(a.map(p => [p.x, p.y, p.angle]), [[10, 20, 0], [30, 40, 0]]);
});

test('point placement of a polygon: the middle of its box', () => {
    const a = anchors({ type: 'Polygon', geometry: [[[0, 0], [100, 0], [100, 50], [0, 50]]] }, 'point', 0, false);
    assert.deepEqual(a.map(p => [p.x, p.y]), [[50, 25]]);
});

test('line placement: every symbol-spacing pixels, starting half a spacing in', () => {
    const a = anchors({ type: 'LineString', geometry: [[[0, 0], [1000, 0]]] }, 'line', 250, false);
    assert.deepEqual(a.map(p => p.x), [125, 375, 625, 875]);
    assert.ok(a.every(p => p.y === 0 && p.angle === 0 && p.lineLength === 1000));
});

test('line placement: short lines get one anchor in the middle', () => {
    const a = anchors({ type: 'LineString', geometry: [[[0, 0], [100, 0]]] }, 'line', 250, false);
    assert.deepEqual(a.map(p => p.x), [50]);
});

test('line-center: the middle of the longest part', () => {
    const a = anchors({ type: 'LineString', geometry: [[[0, 0], [10, 0]], [[0, 100], [0, 300]]] }, 'line-center', 0, false);
    assert.equal(a.length, 1);
    assert.deepEqual([a[0].x, a[0].y], [0, 200]);
});

test('angles along lines are kept upright; viewport alignment keeps 0', () => {
    const leftwards = anchors({ type: 'LineString', geometry: [[[1000, 0], [0, 0]]] }, 'line', 400, false);
    assert.ok(leftwards.every(p => Math.abs(p.angle) < 1e-9), 'a line drawn right to left: text not upside down');
    const down = anchors({ type: 'LineString', geometry: [[[0, 0], [0, 1000]]] }, 'line', 400, false);
    assert.ok(down.every(p => Math.abs(p.angle - Math.PI / 2) < 1e-9));
    const viewport = anchors({ type: 'LineString', geometry: [[[0, 0], [0, 1000]]] }, 'line', 400, true);
    assert.ok(viewport.every(p => p.angle === 0));
});

test('iconInTile: only symbol layers marked for the tile images', () => {
    assert.equal(iconInTile({ type: 'symbol', 'gview:inTile': true }), true);
    assert.equal(iconInTile({ type: 'symbol' }), false);
    assert.equal(iconInTile({ type: 'line', 'gview:inTile': true }), false);
});

test('which symbol layers are drawn into the tile images (option iconsInTiles)', () => {
    const layer = Object.create(plugin.prototype);
    const style = { layers: [
        { id: 'dots', type: 'symbol', layout: { 'icon-image': 'dot', 'icon-allow-overlap': true } },
        { id: 'dots-sdf', type: 'symbol', layout: { 'icon-image': 'dot', 'icon-allow-overlap': true }, paint: { 'icon-color': '#f00' } },
        { id: 'poi', type: 'symbol', layout: { 'icon-image': 'poi', 'text-field': '{name}', 'icon-allow-overlap': true } },
        { id: 'shield', type: 'symbol', layout: { 'icon-image': 'shield' } },
        { id: 'roads', type: 'line' }
    ] };
    layer.options = { iconsInTiles: true };
    layer._markIconsInTiles(style);
    assert.deepEqual(style.layers.filter(l => l['gview:inTile']).map(l => l.id), ['dots', 'dots-sdf']);
    layer.options = { iconsInTiles: false };
    layer._markIconsInTiles(style);
    assert.deepEqual(style.layers.filter(l => l['gview:inTile']).map(l => l.id), []);
});

test('fill-extrusion (3D buildings) becomes a flat fill with its color and opacity', () => {
    const layer = Object.create(plugin.prototype);
    layer.options = {};
    const style = { layers: [{ id: 'building-3d', type: 'fill-extrusion', paint: {
        'fill-extrusion-color': 'hsl(35,8%,85%)', 'fill-extrusion-opacity': 0.8, 'fill-extrusion-height': ['get', 'render_height']
    } }] };
    layer._markIconsInTiles(style);
    assert.equal(style.layers[0].type, 'fill');
    assert.deepEqual(plain(style.layers[0].paint), { 'fill-color': 'hsl(35,8%,85%)', 'fill-opacity': 0.8 });
});

// glyphs of 10 px each
const measure = text => Array.from(text).length * 10;

test('text along a straight line: centered, glyph by glyph', () => {
    const glyphs = plain(placeAlongPath(measure, 'ABCD', [[0, 0], [200, 0]], 100, Math.PI / 4, 0));
    assert.deepEqual(glyphs.map(g => g.ch).join(''), 'ABCD');
    assert.deepEqual(glyphs.map(g => Math.round(g.x * 1e6) / 1e6), [85, 95, 105, 115]);
    assert.ok(glyphs.every(g => g.y === 0 && g.angle === 0));
});

test('text along a line drawn right to left is turned upright (read left to right)', () => {
    const glyphs = plain(placeAlongPath(measure, 'AB', [[200, 0], [0, 0]], 100, Math.PI / 4, 0));
    assert.ok(glyphs[0].x < glyphs[1].x, 'A left of B');
    assert.ok(glyphs.every(g => Math.abs(Math.cos(g.angle) - 1) < 1e-9));
});

test('text along a line: letter spacing, too long, too sharp a bend', () => {
    const spaced = plain(placeAlongPath(measure, 'AB', [[0, 0], [200, 0]], 100, Math.PI / 4, 4));
    assert.ok(Math.abs(spaced[1].x - spaced[0].x - 14) < 1e-9);
    assert.equal(placeAlongPath(measure, 'ABCDEFGHIJK', [[0, 0], [100, 0]], 50, Math.PI / 4, 0), null, 'longer than the line');
    assert.equal(placeAlongPath(measure, 'ABCD', [[0, 0], [100, 0], [100, 100]], 100, Math.PI / 8, 0), null, 'a right angle in the middle');
    assert.ok(placeAlongPath(measure, 'ABCD', [[0, 0], [100, 0], [100, 100]], 100, Math.PI, 0), 'allowed with a large max angle');
});

test('runs: consecutive geometry layers of one source, labels and backgrounds left out', () => {
    const layer = Object.create(plugin.prototype);
    const style = { layers: [
        { id: 'bg', type: 'background' },
        { id: 'land', type: 'fill', source: 'landcover' },
        { id: 'water', type: 'fill', source: 'base' },
        { id: 'roads', type: 'line', source: 'base' },
        { id: 'labels', type: 'symbol', source: 'base' },
        { id: 'forest', type: 'fill', source: 'landcover' },
        { id: 'dots', type: 'symbol', source: 'landcover', 'gview:inTile': true },
        { id: 'names', type: 'symbol', source: 'landcover' },
        { id: 'bridges', type: 'line', source: 'base' }
    ] };
    assert.deepEqual(plain(layer._buildRuns(style)), [
        { source: 'landcover', from: 1, to: 1, index: 0 },
        { source: 'base', from: 2, to: 3, index: 1 },
        { source: 'landcover', from: 5, to: 6, index: 2 },
        { source: 'base', from: 8, to: 8, index: 3 }
    ]);
});

const { localizeTextField, anchorOffset, justification } = plugin._internals;

test('language: name fields of text-field prefer name:<lang> / name_<lang>', () => {
    const expected = ['coalesce', ['get', 'name:de'], ['get', 'name_de'], ['get', 'name']];
    assert.deepEqual(plain(localizeTextField(['get', 'name'], 'de')), expected);
    assert.deepEqual(plain(localizeTextField('{name}', 'de')), expected, 'a legacy token');
    assert.deepEqual(plain(localizeTextField(['coalesce', ['get', 'name_en'], ['get', 'name']], 'de')),
        ['coalesce', ['coalesce', ['get', 'name:de'], ['get', 'name_de'], ['get', 'name_en']], expected]);
    assert.deepEqual(plain(localizeTextField('{name:latin}\n{name:nonlatin}', 'de')), ['concat',
        ['coalesce', ['get', 'name:de'], ['get', 'name_de'], ['get', 'name:latin']], '\n',
        ['coalesce', ['get', 'name:de'], ['get', 'name_de'], ['get', 'name:nonlatin']]]);
    assert.equal(localizeTextField('{ref}', 'de'), '{ref}', 'other fields untouched');
    assert.deepEqual(plain(localizeTextField(['get', 'ref'], 'de')), ['get', 'ref']);
    assert.equal(localizeTextField('Wien', 'de'), 'Wien');
    // the result evaluates as expected
    const f = { properties: { name: 'Wien', 'name:en': 'Vienna', name_de: 'Wien (de)' } };
    assert.equal(shared.evaluateValue(localizeTextField(['get', 'name'], 'en'), f, 0), 'Vienna');
    assert.equal(shared.evaluateValue(localizeTextField(['get', 'name'], 'de'), f, 0), 'Wien (de)');
    assert.equal(shared.evaluateValue(localizeTextField(['get', 'name'], 'fr'), f, 0), 'Wien', 'fallback: the original');
});

test('text-variable-anchor: offsets away from the anchor point; text-justify auto', () => {
    assert.deepEqual(plain(anchorOffset('top', 1, [0, 0])), [0, 1]);
    assert.deepEqual(plain(anchorOffset('right', 2, [0, 0])), [-2, 0]);
    const d = plain(anchorOffset('bottom-left', 1, [0, 0]));
    assert.ok(Math.abs(d[0] - Math.SQRT1_2) < 1e-9 && Math.abs(d[1] + Math.SQRT1_2) < 1e-9);
    assert.deepEqual(plain(anchorOffset('top', null, [0, 0.8])), [0, 0.8], 'no radial offset: the text-offset');
    assert.equal(justification('auto', 'top-left'), 'left');
    assert.equal(justification('auto', 'right'), 'right');
    assert.equal(justification('auto', 'top'), 'center');
    assert.equal(justification('right', 'left'), 'right');
});

test('line-offset: a line moved to the right of its direction', () => {
    const calls = [];
    const ctx = { moveTo: (x, y) => calls.push(['M', x, y]), lineTo: (x, y) => calls.push(['L', x, y]), closePath() {} };
    const id = p => p[0];
    // eastwards, offset 3: south (y + 3 on screen)
    shared.addOffsetPath(ctx, [[0, 10], [100, 10]], id, p => p[1], 3, false);
    assert.deepEqual(calls, [['M', 0, 13], ['L', 100, 13]]);
    // a right angle: the corner on the miter
    calls.length = 0;
    shared.addOffsetPath(ctx, [[0, 0], [100, 0], [100, 100]], id, p => p[1], 2, false);
    assert.deepEqual(calls.map(c => c.slice(1).map(v => Math.round(v))), [[0, 2], [98, 2], [98, 100]]);
});
