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

test('interpolate between colors (hex, rgb, hsl, names) and arrays', () => {
    const color = ['interpolate', ['linear'], ['zoom'], 10, '#000000', 20, '#ffffff'];
    assert.equal(ev(color, road, 15), 'rgba(128,128,128,1)');
    assert.equal(ev(['interpolate', ['linear'], ['zoom'], 0, 'rgba(255,0,0,0)', 10, 'rgba(255,0,0,1)'], road, 5), 'rgba(255,0,0,0.5)');
    assert.equal(ev(['interpolate', ['linear'], ['zoom'], 0, 'hsl(0, 100%, 50%)', 10, 'blue'], road, 0), 'hsl(0, 100%, 50%)', 'at a stop: the stop value');
    assert.equal(ev(['interpolate', ['linear'], ['zoom'], 0, 'hsl(120, 100%, 50%)', 10, 'black'], road, 5), 'rgba(0,128,0,1)');
    assert.equal(ev(['interpolate', ['linear'], ['zoom'], 0, '#fff', 10, '#00000080'], road, 10), '#00000080');
    assert.deepEqual(plain(ev(['interpolate', ['linear'], ['zoom'], 0, ['literal', [0, 0]], 10, ['literal', [4, 8]]], road, 5)), [2, 4]);
    assert.equal(ev({ stops: [[10, '#000'], [20, '#fff']] }, road, 15), 'rgba(128,128,128,1)', 'legacy function with colors');
    assert.equal(shared.parseColor('nonsense'), null);
});

test('interpolate: cubic-bezier easing', () => {
    const ramp = ['interpolate', ['cubic-bezier', 0.42, 0, 0.58, 1], ['zoom'], 0, 0, 10, 100];
    assert.ok(Math.abs(ev(ramp, road, 5) - 50) < 0.01, 'symmetric ease-in-out: half way at the middle');
    assert.ok(ev(ramp, road, 2) < 20, 'slow start');
});

test('coalesce, typeof, type conversions and assertions', () => {
    assert.equal(ev(['coalesce', ['get', 'name_en'], ['get', 'name']], road, 0), 'Ringstraße');
    assert.equal(ev(['coalesce', ['get', 'a'], ['get', 'b']], road, 0), null);
    assert.equal(ev(['typeof', ['get', 'lanes']], road, 0), 'number');
    assert.equal(ev(['typeof', ['get', 'missing']], road, 0), 'null');
    assert.equal(ev(['to-boolean', ['get', 'name']], road, 0), true);
    assert.equal(ev(['to-number', ['get', 'missing'], '7'], road, 0), 7);
    assert.equal(ev(['string', ['get', 'lanes'], 'fallback'], road, 0), 'fallback');
    assert.equal(ev(['number', ['get', 'lanes'], 0], road, 0), 4);
    assert.equal(ev(['to-color', 'nonsense', '#123'], road, 0), '#123');
});

test('strings: upcase, downcase, length, slice, in, index-of, format, number-format, image', () => {
    assert.equal(ev(['upcase', ['get', 'ref']], road, 0), 'B1');
    assert.equal(ev(['downcase', ['get', 'name']], road, 0), 'ringstraße');
    assert.equal(ev(['length', ['get', 'name']], road, 0), 10);
    assert.equal(ev(['slice', ['get', 'name'], 0, 4], road, 0), 'Ring');
    assert.equal(ev(['in', 'straße', ['get', 'name']], road, 0), true, 'substring');
    assert.equal(ev(['index-of', 'straße', ['get', 'name']], road, 0), 4);
    assert.equal(ev(['format', ['get', 'ref'], { 'font-scale': 0.8 }, ' ', {}, ['get', 'name'], { 'text-font': ['literal', ['Bold']] }], road, 0), 'B1 Ringstraße');
    assert.equal(ev(['number-format', 3.14159, { 'max-fraction-digits': 2, locale: 'en' }], road, 0), '3.14');
    assert.equal(ev(['image', 'icon-bus'], road, 0), 'icon-bus');
});

test('math', () => {
    assert.equal(ev(['+', 1, 2, 3], road, 0), 6);
    assert.equal(ev(['-', 10, ['get', 'lanes']], road, 0), 6);
    assert.equal(ev(['-', 5], road, 0), -5);
    assert.equal(ev(['*', ['get', 'lanes'], 2.5], road, 0), 10);
    assert.equal(ev(['/', 9, 2], road, 0), 4.5);
    assert.equal(ev(['%', ['get', 'lanes'], 3], road, 0), 1);
    assert.equal(ev(['^', 2, 10], road, 0), 1024);
    assert.equal(ev(['min', 3, 1, 2], road, 0), 1);
    assert.equal(ev(['max', 3, 1, 2], road, 0), 3);
    assert.equal(ev(['round', 2.5], road, 0), 3);
    assert.equal(ev(['floor', ['zoom']], road, 12.7), 12);
    assert.equal(ev(['abs', -2], road, 0), 2);
    assert.equal(ev(['sqrt', 16], road, 0), 4);
});

test('let / var, id, properties, at', () => {
    assert.equal(ev(['let', 'w', ['*', ['get', 'lanes'], 2], ['+', ['var', 'w'], 1]], road, 0), 9);
    assert.equal(ev(['let', 'a', 1, ['let', 'b', 2, ['+', ['var', 'a'], ['var', 'b']]]], road, 0), 3, 'nested scopes');
    assert.equal(ev(['var', 'unknown'], road, 0), null);
    assert.equal(ev(['id'], road, 0), 42);
    assert.equal(ev(['get', 'name', ['properties']], road, 0), 'Ringstraße');
    assert.equal(ev(['at', 1, ['literal', ['a', 'b', 'c']]], road, 0), 'b');
});

test('legacy functions (stops)', () => {
    assert.equal(ev({ type: 'identity', property: 'class' }, road, 0), 'primary', 'identity without stops');
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

test('color schemes: grayscale, pale, dark, a function; colors that cannot be parsed stay', () => {
    const { schemeColor, colorSchemeFunction } = shared;
    const gray = colorSchemeFunction('grayscale'), pale = colorSchemeFunction('pale'), dark = colorSchemeFunction('dark');
    assert.equal(schemeColor('#ff0000', gray), 'rgba(54,54,54,1)');
    assert.equal(schemeColor('rgba(0,128,255,0.5)', gray), 'rgba(110,110,110,0.5)', 'alpha kept');
    const p = shared.parseColor(schemeColor('#008000', pale));
    assert.ok(p[0] > 100 && p[1] > 150 && p[2] > 100, 'pale: lighter, less saturated');
    assert.equal(schemeColor('#ffffff', dark), 'rgba(20,20,20,1)', 'white → dark gray, not black');
    assert.equal(schemeColor('#000000', dark), 'rgba(224,224,224,1)', 'black → light gray');
    const water = shared.parseColor(schemeColor('#a0c8f0', dark));
    assert.ok(water[2] > water[0] && water[0] < 100, 'dark: light blue water becomes dark blue (hue kept)');
    assert.equal(schemeColor('#123456', (c) => [255 - c[0], 255 - c[1], 255 - c[2], c[3]]), 'rgba(237,203,169,1)', 'own function');
    assert.equal(schemeColor('nonsense', gray), 'nonsense');
    assert.equal(colorSchemeFunction(null), null);
    assert.equal(colorSchemeFunction('unknown'), null);
});

test('the renderer: paint colors through the scheme, other values untouched', () => {
    const renderer = new shared.TileRenderer();
    renderer.setColorScheme(shared.colorSchemeFunction('grayscale'));
    const layer = { id: 'x', paint: { 'fill-color': '#ff0000', 'fill-opacity': 0.5, 'line-color': ['interpolate', ['linear'], ['zoom'], 0, '#000', 10, '#fff'] } };
    assert.equal(renderer._paint(layer, 'fill-color', null, 5, null), 'rgba(54,54,54,1)');
    assert.equal(renderer._paint(layer, 'fill-opacity', null, 5, null), 0.5);
    assert.equal(renderer._paint(layer, 'line-color', null, 5, null), 'rgba(128,128,128,1)');
    renderer.setColorScheme(null);
    assert.equal(renderer._paint(layer, 'fill-color', null, 5, null), '#ff0000');
});

test('a scheme function sent to the worker as source works there too', () => {
    const fn = function (c) { return [c[2], c[1], c[0], c[3]]; };
    const restored = (new Function('return (' + fn.toString() + ');'))();
    assert.equal(shared.schemeColor('#102030', restored), 'rgba(48,32,16,1)');
});

test('color schemes: contrast, colorblind, sepia, tint', () => {
    const { schemeColor, colorSchemeFunction, parseColor } = shared;
    const f = name => colorSchemeFunction(name);
    // contrast: white stays, pastel areas clearly darker; text black or white
    assert.equal(schemeColor('#ffffff', f('contrast'), { property: 'fill-color' }), 'rgba(255,255,255,1)');
    const pastel = parseColor(schemeColor('#e8c8c8', f('contrast'), { property: 'fill-color' }));
    assert.ok(pastel[1] < 160, 'pastel areas darker (more contrast to white roads)');
    assert.equal(schemeColor('#555555', f('contrast'), { property: 'text-color' }), 'rgba(0,0,0,1)');
    assert.equal(schemeColor('rgba(255,255,255,0.6)', f('contrast'), { property: 'text-halo-color' }), 'rgba(255,255,255,0.9)');
    // colorblind: red and green farther apart in blue (what deuteranopes still see), gray untouched
    const red = parseColor(schemeColor('#ff0000', f('colorblind'))), green = parseColor(schemeColor('#00a000', f('colorblind')));
    assert.ok(red[2] - green[2] > 100, 'red gets blue, green does not');
    assert.equal(schemeColor('#808080', f('colorblind')), 'rgba(128,128,128,1)');
    // sepia: warm, muted tones; white becomes a paper tone, not bright yellow
    const s = parseColor(schemeColor('#3366cc', f('sepia')));
    assert.ok(s[0] > s[2], 'warm');
    assert.equal(schemeColor('#ffffff', f('sepia')), 'rgba(245,237,221,1)');
    const yellow = parseColor(schemeColor('#fff5c8', f('sepia')));
    assert.ok(yellow[0] - yellow[2] < 40, 'light yellow stays muted');
    // tint: white stays white, dark becomes the color
    assert.equal(schemeColor('#ffffff', f('tint:#1f6feb')), 'rgba(255,255,255,1)');
    const dark = parseColor(schemeColor('#000000', f('tint:#1f6feb')));
    assert.ok(dark[2] > dark[0] && dark[2] > 150, 'black → dark blue');
    assert.ok(colorSchemeFunction('tint:nonsense'), 'an unparsable tint color: a default tint');
});

test('highlighting: layers not highlighted dimmed (colors, icon opacity), highlighted ones untouched', () => {
    const renderer = new shared.TileRenderer();
    const roads = { id: 'roads', paint: { 'line-color': '#ff0000', 'icon-opacity': 1 } };
    const water = { id: 'water', paint: { 'fill-color': '#0000ff', 'icon-opacity': 0.8 } };
    renderer.setHighlight({ roads: true }, shared.colorSchemeFunction('grayscale'));
    assert.equal(renderer._paint(roads, 'line-color', null, 10, null), '#ff0000', 'highlighted: as in the style');
    assert.equal(renderer._paint(water, 'fill-color', null, 10, null), 'rgba(18,18,18,1)', 'dimmed: grayscale');
    assert.equal(renderer._paint(roads, 'icon-opacity', null, 10, null), 1);
    assert.ok(Math.abs(renderer._paint(water, 'icon-opacity', null, 10, null) - 0.28) < 1e-9, 'icons fainter');
    // with a color scheme: the scheme for all, the dimming on top for the others
    renderer.setColorScheme(shared.colorSchemeFunction('dark'));
    const highlighted = renderer._paint(roads, 'line-color', null, 10, null);
    assert.notEqual(highlighted, '#ff0000');
    assert.equal(renderer._paint(water, 'fill-color', null, 10, null),
        shared.schemeColor(shared.schemeColor('#0000ff', shared.colorSchemeFunction('dark')), shared.colorSchemeFunction('grayscale')));
    renderer.setHighlight(null);
    renderer.setColorScheme(null);
    assert.equal(renderer._paint(water, 'fill-color', null, 10, null), '#0000ff', 'off again');
});

test('a scheme function depending on the layer: cached per layer', () => {
    const renderer = new shared.TileRenderer();
    renderer.setColorScheme((c, info) => info.layer === 'a' ? [0, 0, 0, c[3]] : [255, 255, 255, c[3]]);
    assert.equal(renderer._paint({ id: 'a', paint: { 'fill-color': '#888' } }, 'fill-color', null, 1, null), 'rgba(0,0,0,1)');
    assert.equal(renderer._paint({ id: 'b', paint: { 'fill-color': '#888' } }, 'fill-color', null, 1, null), 'rgba(255,255,255,1)');
});
