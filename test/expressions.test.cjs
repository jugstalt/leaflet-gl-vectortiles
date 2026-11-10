'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./helpers/load.cjs');

const { shared } = load();
const { evaluateValue: ev, resolveTokens, filterMatches, filterUsesZoom, layerIsDataDriven } = shared;

const feature = (properties, type = 'Point', id = 1) => ({ id, type, properties, geometry: [] });
const road = feature({ class: 'primary', name: 'Ringstraße', lanes: 4, ref: 'B1', bridge: false }, 'LineString', 42);

test('constants and literals', () => {
    assert.equal(ev('#ff0000', road, 10), '#ff0000');
    assert.equal(ev(3, road, 10), 3);
    assert.deepEqual(plain(ev(['literal', [1, 2]], road, 10)), [1, 2]);
    assert.deepEqual(plain(ev([2, 1], road, 10)), [2, 1], 'array literal without "literal" (dash arrays)');
});

test('get, has, zoom, geometry-type', () => {
    assert.equal(ev(['get', 'name'], road, 10), 'Ringstraße');
    assert.equal(ev(['get', 'missing'], road, 10), null);
    assert.equal(ev(['has', 'lanes'], road, 10), true);
    assert.equal(ev(['!has', 'lanes'], road, 10), false);
    assert.equal(ev(['zoom'], road, 12.5), 12.5);
    assert.equal(ev(['geometry-type'], road, 10), 'LineString');
});

test('comparisons and logic', () => {
    assert.equal(ev(['==', ['get', 'class'], 'primary'], road, 0), true);
    assert.equal(ev(['!=', ['get', 'class'], 'primary'], road, 0), false);
    assert.equal(ev(['>', ['get', 'lanes'], 2], road, 0), true);
    assert.equal(ev(['<=', ['get', 'lanes'], 3], road, 0), false);
    assert.equal(ev(['all', ['>=', ['zoom'], 10], ['==', ['get', 'ref'], 'B1']], road, 11), true);
    assert.equal(ev(['all', ['>=', ['zoom'], 10], ['==', ['get', 'ref'], 'B1']], road, 9), false);
    assert.equal(ev(['any', ['get', 'bridge'], ['==', ['get', 'lanes'], 4]], road, 0), true);
    assert.equal(ev(['!', ['get', 'bridge']], road, 0), true);
    assert.equal(ev(['in', ['get', 'class'], ['literal', ['primary', 'secondary']]], road, 0), true);
    assert.equal(ev(['in', ['get', 'class'], ['literal', ['service']]], road, 0), false);
});

test('to-string, to-number, concat', () => {
    assert.equal(ev(['to-string', ['get', 'lanes']], road, 0), '4');
    assert.equal(ev(['to-string', ['get', 'missing']], road, 0), '');
    assert.equal(ev(['to-number', '12.5'], road, 0), 12.5);
    assert.equal(ev(['to-number', 'abc'], road, 0), 0);
    assert.equal(ev(['concat', ['get', 'ref'], ' ', ['get', 'name'], ['get', 'missing']], road, 0), 'B1 Ringstraße');
});

test('match, case, step', () => {
    const color = ['match', ['get', 'class'], 'motorway', 'red', ['primary', 'trunk'], 'orange', 'gray'];
    assert.equal(ev(color, road, 0), 'orange');
    assert.equal(ev(color, feature({ class: 'path' }), 0), 'gray');

    const width = ['case', ['==', ['get', 'class'], 'motorway'], 8, ['>', ['get', 'lanes'], 2], 5, 1];
    assert.equal(ev(width, road, 0), 5);
    assert.equal(ev(width, feature({ lanes: 1 }), 0), 1);

    const step = ['step', ['zoom'], 1, 10, 2, 14, 4];
    assert.equal(ev(step, road, 5), 1);
    assert.equal(ev(step, road, 10), 2);
    assert.equal(ev(step, road, 13.9), 2);
    assert.equal(ev(step, road, 20), 4);
});

test('interpolate: linear, exponential, clamped at the ends', () => {
    const linear = ['interpolate', ['linear'], ['zoom'], 10, 1, 20, 11];
    assert.equal(ev(linear, road, 5), 1);
    assert.equal(ev(linear, road, 15), 6);
    assert.equal(ev(linear, road, 25), 11);

    const exponential = ['interpolate', ['exponential', 2], ['zoom'], 10, 0, 12, 3];
    // base 2: (2^1 - 1) / (2^2 - 1) = 1/3 of the way at zoom 11
    assert.equal(ev(exponential, road, 11), 1);
    assert.equal(ev(['interpolate', ['exponential', 1], ['zoom'], 0, 0, 10, 10], road, 5), 5, 'base 1 is linear');
});

test.todo('interpolate between colors (e.g. "#fff" → "#000"), as many OpenMapTiles styles use it');
test.todo('more expressions: coalesce, let/var, upcase/downcase, length, at, +, -, *, /, min, max, format, number-format');

test('legacy functions (stops)', () => {
    assert.equal(ev({ stops: [[10, 1], [20, 11]] }, road, 15), 6, 'linear');
    assert.equal(ev({ base: 2, stops: [[10, 0], [12, 3]] }, road, 11), 1, 'exponential');
    assert.equal(ev({ stops: [[10, 'thin'], [15, 'wide']] }, road, 12), 'thin', 'non-numeric: steps');
    assert.equal(ev({ type: 'interval', stops: [[0, 1], [10, 2]] }, road, 9.9), 1);
    assert.equal(ev({ property: 'class', type: 'categorical', stops: [['primary', 'orange']], default: 'gray' }, road, 0), 'orange');
    assert.equal(ev({ property: 'class', type: 'categorical', stops: [['motorway', 'red']], default: 'gray' }, road, 0), 'gray');
    assert.equal(ev({ property: 'lanes', type: 'identity' }, road, 0), 4);
    assert.equal(ev({ stops: [[{ zoom: 10, value: 1 }, 2], [{ zoom: 20, value: 1 }, 12]] }, road, 15), 7, 'zoom-and-property stops: by zoom');
});

test('legacy {field} tokens', () => {
    assert.equal(resolveTokens('{ref} {name}', road), 'B1 Ringstraße');
    assert.equal(resolveTokens('{missing}x', road), 'x');
    assert.equal(resolveTokens('no tokens', road), 'no tokens');
    assert.equal(resolveTokens(5, road), 5);
});

test('filters: legacy syntax', () => {
    assert.equal(filterMatches(['==', 'class', 'primary'], road, 0), true);
    assert.equal(filterMatches(['!=', 'class', 'primary'], road, 0), false);
    assert.equal(filterMatches(['in', 'class', 'motorway', 'primary'], road, 0), true);
    assert.equal(filterMatches(['!in', 'class', 'motorway', 'primary'], road, 0), false);
    assert.equal(filterMatches(['has', 'ref'], road, 0), true);
    assert.equal(filterMatches(['!has', 'ref'], road, 0), false);
    assert.equal(filterMatches(['==', '$type', 'LineString'], road, 0), true);
    assert.equal(filterMatches(['==', '$id', 42], road, 0), true);
    assert.equal(filterMatches(['all', ['==', 'class', 'primary'], ['>=', 'lanes', 4]], road, 0), true);
    assert.equal(filterMatches(['any', ['==', 'class', 'motorway'], ['<', 'lanes', 2]], road, 0), false);
    assert.equal(filterMatches(['none', ['==', 'class', 'motorway']], road, 0), true);
});

test('filters: expressions, none, zoom', () => {
    assert.equal(filterMatches(null, road, 0), true, 'no filter');
    assert.equal(filterMatches(['==', ['get', 'class'], 'primary'], road, 0), true);
    assert.equal(filterMatches(['all', ['==', ['geometry-type'], 'LineString'], ['>=', ['zoom'], 12]], road, 11), false);
    assert.equal(filterUsesZoom(['all', ['>=', ['zoom'], 12]]), true);
    assert.equal(filterUsesZoom(['==', 'class', 'primary']), false);
    assert.equal(filterUsesZoom(undefined), false);
});

test('data driven style layers are detected (drawn feature by feature)', () => {
    assert.equal(layerIsDataDriven({ paint: { 'line-color': '#000', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 2] } }), false);
    assert.equal(layerIsDataDriven({ paint: { 'line-color': ['match', ['get', 'class'], 'a', 'red', 'blue'] } }), true);
    assert.equal(layerIsDataDriven({ paint: { 'fill-color': { property: 'kind', stops: [['a', 'red']] } } }), true);
    assert.equal(layerIsDataDriven({ layout: { 'text-field': '{name}' } }), false, 'tokens are resolved per feature anyway');
});
