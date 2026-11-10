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
