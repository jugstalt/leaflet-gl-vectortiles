'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./helpers/load.cjs');

const { plugin, shared } = load();
const { resolveUrl, cssFont } = plugin._internals;

// a layer object without a map: _loadSource with fixed JSON answers instead of the network
function layerWith(responses, mapEpsg = null) {
    const layer = Object.create(plugin.prototype);
    layer.options = {};
    layer._sources = {};
    layer._sourceAttributions = {};
    layer._mapEpsg = () => mapEpsg;
    layer.requested = [];
    layer._fetchJson = url => {
        layer.requested.push(url);
        if (!(url in responses)) return Promise.reject(new Error('unexpected request ' + url));
        return Promise.resolve(JSON.parse(JSON.stringify(responses[url])));
    };
    return layer;
}

test('resolveUrl keeps the {z}/{x}/{y} placeholders', () => {
    assert.equal(resolveUrl('tiles/{z}/{x}/{y}.pbf', 'https://a.example/styles/root.json'), 'https://a.example/styles/tiles/{z}/{x}/{y}.pbf');
    assert.equal(resolveUrl('../../tiles/{z}/{x}/{y}.pbf', 'https://a.example/a/b/c/tiles.json'), 'https://a.example/a/tiles/{z}/{x}/{y}.pbf');
    assert.equal(resolveUrl('https://other.example/x.json', 'https://a.example/'), 'https://other.example/x.json');
});

test('TileJSON file: tile URLs relative to its folder (BEV cadastre), attribution from it', async () => {
    const base = 'https://kataster.example/styles_kataster';
    const layer = layerWith({
        [`${base}/kataster/tiles.json`]: {
            tilejson: '2.2.0', tiles: ['../../tiles/kataster/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 16,
            attribution: "&copy; <a href='https://bev.gv.at'>BEV</a>"
        }
    });
    await layer._loadSource('kataster', { type: 'vector', url: './tiles.json' }, `${base}/kataster/style_vermv.json`, null);
    const source = layer._sources.kataster;
    assert.equal(source.tileUrl, 'https://kataster.example/tiles/kataster/{z}/{x}/{y}.pbf');
    assert.equal(source.maxLevel, 16);
    assert.equal(source.gview, false);
    assert.equal(layer._sourceAttributions.kataster, "&copy; <a href='https://bev.gv.at'>BEV</a>");
});

test('ESRI VectorTileServer: tiles relative to the service, maxLOD, tile size, copyrightText escaped', async () => {
    const service = 'https://maps.example/arcgis/rest/services/Basemap/VectorTileServer';
    const layer = layerWith({
        [service]: {
            tiles: ['tile/{z}/{y}/{x}.pbf'], maxLOD: 18, tileInfo: { rows: 512, cols: 512 },
            copyrightText: 'Esri & <partners>'
        }
    });
    await layer._loadSource('esri', { type: 'vector', url: service }, 'https://maps.example/style/root.json', null);
    const source = layer._sources.esri;
    assert.equal(source.tileUrl, service + '/tile/{z}/{y}/{x}.pbf');
    assert.equal(source.maxLevel, 18);
    assert.deepEqual(plain(source.grid.tileSize), [512, 512]);
    assert.equal(source.grid.resolutions.length, 19);
    assert.equal(layer._sourceAttributions.esri, 'Esri &amp; &lt;partners&gt;');
});

test('tiles in the style: relative to the style URL, no request', async () => {
    const layer = layerWith({});
    await layer._loadSource('v', { type: 'vector', tiles: ['../tiles/{z}/{x}/{y}.pbf'], maxzoom: 14, attribution: 'X' },
        'https://a.example/styles/style.json', null);
    assert.equal(layer._sources.v.tileUrl, 'https://a.example/tiles/{z}/{x}/{y}.pbf');
    assert.equal(layer._sources.v.maxLevel, 14);
    assert.equal(layer._sourceAttributions.v, 'X');
    assert.equal(layer.requested.length, 0);
});

test('a WebMercator source on a map in another projection is refused', async () => {
    const layer = layerWith({}, '31256');
    await assert.rejects(layer._loadSource('v', { type: 'vector', tiles: ['t/{z}/{x}/{y}.pbf'] }, 'https://a.example/s.json', null),
        /WebMercator vector tile source, the map is EPSG:31256/);
});

test('gView source: its own grid, refused on a map in another projection', async () => {
    const grid = { epsg: 31256, origin: [-5000000, 5000000], resolutions: [264.58, 132.29, 66.14], tileSize: [512, 512], webmercator: false };
    const ok = layerWith({}, '31256');
    await ok._loadSource('gview', { type: 'vector', tiles: ['tiles/{z}/{y}/{x}.pbf'] }, 'https://gview.example/vtc/svc/style.json', grid);
    assert.equal(ok._sources.gview.gview, true);
    assert.equal(ok._sources.gview.maxLevel, 2);
    assert.deepEqual(plain(ok._sources.gview.zooms), [0, 1, 2]);

    const wrong = layerWith({}, '3857');
    await assert.rejects(wrong._loadSource('gview', { type: 'vector', tiles: ['t'] }, 'https://gview.example/s.json', grid),
        /The map is EPSG:3857, the tile cache EPSG:31256/);
});

test('cssFont: GL font names to CSS fonts (numeric weights)', () => {
    assert.equal(cssFont(['Open Sans Bold'], 14), '700 14px "Open Sans", sans-serif');
    assert.equal(cssFont(['Noto Sans Italic'], 12), 'italic 400 12px "Noto Sans", sans-serif');
    assert.equal(cssFont(['Arial Regular'], 13.333), '400 13.3px "Arial", sans-serif');
    assert.equal(cssFont(['Open Sans Semibold Italic'], 10), 'italic 600 10px "Open Sans", sans-serif');
    assert.equal(cssFont(['Roboto Light'], 10), '300 10px "Roboto", sans-serif');
    assert.equal(cssFont(null, 10), '400 10px "Arial", sans-serif');
});

test('web fonts: URLs from the ol:webfonts template, the fonts of a style', () => {
    const { fontParts, webfontUrl, styleFonts } = plugin._internals;
    const t = '../fonts/{font-family}/{fontweight}{-fontstyle}.css';
    assert.equal(webfontUrl(t, fontParts('Roboto Bold')), '../fonts/roboto/700.css');
    assert.equal(webfontUrl(t, fontParts(['Open Sans Semibold Italic'])), '../fonts/open-sans/600-italic.css');
    assert.equal(resolveUrl(webfontUrl(t, fontParts('Roboto Bold')), 'https://kataster.example/styles/kataster/style_gis.json'),
        'https://kataster.example/styles/fonts/roboto/700.css');
    const style = { layers: [
        { type: 'symbol', layout: { 'text-font': ['Roboto Bold'] } },
        { type: 'symbol', layout: { 'text-font': ['step', ['zoom'], ['literal', ['Noto Sans Regular']], 10, ['literal', ['Noto Sans Bold']]] } },
        { type: 'symbol', layout: { 'text-font': { stops: [[5, ['Open Sans Italic']]] } } },
        { type: 'line', layout: {} }
    ] };
    assert.deepEqual(plain(styleFonts(style)).sort(), ['Noto Sans Bold', 'Noto Sans Regular', 'Open Sans Italic', 'Roboto Bold']);
});

// _loadStyle without a map: fixed JSON answers, the rest of the loading stubbed
function styleLayer(url, responses, options = {}) {
    const layer = layerWith(responses);
    layer.options = Object.assign({ iconsInTiles: true }, options);
    layer._url = url;
    layer._renderer = { setStyle() {}, setSprite() {}, setColorScheme() {}, setHighlight() {} };
    layer._loadSprite = () => Promise.resolve();
    layer._startWorker = () => null;
    layer._updateAttribution = () => {};
    layer.events = [];
    layer.fire = (type, data) => { layer.events.push({ type, data }); return layer; };
    return layer;
}

const STYLE = {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['tiles/{z}/{x}/{y}.pbf'] } },
    layers: [{ id: 'l', type: 'line', source: 'v', 'source-layer': 'roads' }]
};

test('a style URL without .json at its end (OpenFreeMap): after {url}/style.json fails, the URL itself', async () => {
    const layer = styleLayer('https://tiles.example/styles/liberty', { 'https://tiles.example/styles/liberty': STYLE });
    await layer._loadStyle();
    assert.deepEqual(layer.requested, ['https://tiles.example/styles/liberty/style.json', 'https://tiles.example/styles/liberty']);
    assert.equal(layer._style.layers.length, 1);
    assert.equal(layer._sources.v.tileUrl, 'https://tiles.example/styles/tiles/{z}/{x}/{y}.pbf', 'relative to the style URL');
    assert.equal(layer.events.at(-1).type, 'styleload');
});

test('a gView vtc base: {url}/style.json', async () => {
    const layer = styleLayer('https://gview.example/vtc/svc', { 'https://gview.example/vtc/svc/style.json': STYLE });
    await layer._loadStyle();
    assert.deepEqual(layer.requested, ['https://gview.example/vtc/svc/style.json']);
});

test('a TileJSON instead of a style: a clear error', async () => {
    const layer = styleLayer('', { 'https://tiles.example/basemap.json': { tilejson: '2.2.0', tiles: ['x/{z}/{x}/{y}.mvt'] } },
        { style: 'https://tiles.example/basemap.json' });
    await assert.rejects(layer._loadStyle(), /A TileJSON, not a GL style/);   // option defaultStyle: false (the stub's options)
});

test('a source that cannot be loaded: error event, the other sources are loaded', async () => {
    const style = {
        version: 8,
        sources: {
            broken: { type: 'vector', url: 'https://tiles.example/missing.json' },
            ok: { type: 'vector', tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] }
        },
        layers: [{ id: 'a', type: 'line', source: 'broken' }, { id: 'b', type: 'line', source: 'ok' }]
    };
    const layer = styleLayer('', { 'https://tiles.example/style.json': style }, { style: 'https://tiles.example/style.json' });
    await layer._loadStyle();
    assert.deepEqual(Object.keys(layer._sources), ['ok']);
    const error = layer.events.find(e => e.type === 'error');
    assert.equal(error.data.source, 'broken');
    assert.equal(layer.events.at(-1).type, 'styleload');
});

const { imageLayout } = plugin._internals;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test('image layout: extent + dpi + scale → image size', () => {
    // 1000 m × 500 m at 1:5000 = 20 cm × 10 cm; at 300 dpi = 2362 × 1181 px
    const l = imageLayout([0, 0, 1000, 500], { dpi: 300, scale: 5000 });
    assert.deepEqual(plain(l.imageSize), [2362, 1181]);
    assert.ok(near(l.dpi, 300, 1e-3) && near(l.scale, 5000, 1e-3));
    assert.deepEqual(plain(l.extent), [0, 0, 1000, 500], 'extent unchanged');
});

test('image layout: extent + image size → dpi (at the map\'s resolution); the extent widened to the aspect ratio', () => {
    // map: 2 m per CSS pixel; a square extent into a 2:1 image → widened in x, centered
    const l = imageLayout([0, 0, 1000, 1000], { imageSize: [2000, 1000] }, 2);
    assert.deepEqual(plain(l.extent), [-500, 0, 1500, 1000]);
    assert.deepEqual(plain(l.imageSize), [2000, 1000]);
    assert.ok(near(l.dpi, 192), '2000 px for 1000 CSS px: 192 dpi');
    // a wide extent into a tall image → widened in y
    const t = imageLayout([0, 0, 1000, 100], { imageSize: [500, 1000], scale: 1000 });
    assert.deepEqual(plain(t.extent), [0, -950, 1000, 1050]);
});

test('image layout: extent + image size + dpi → scale', () => {
    const l = imageLayout([0, 0, 2000, 1000], { imageSize: [2400, 1200], dpi: 240 });
    // 2400 px at 240 dpi = 10 in = 25.4 cm for 2000 m → 1:7874
    assert.ok(near(l.scale, 2000 / 0.254, 1e-3));
    assert.deepEqual(plain(l.cssSize), [960, 480]);
});

test('image layout: too large or empty', () => {
    assert.throws(() => imageLayout([0, 0, 100000, 100000], { dpi: 300, scale: 1000 }), /too large/);
    assert.throws(() => imageLayout([0, 0, 0, 10], { dpi: 96, scale: 1000 }), /empty extent/);
    assert.throws(() => imageLayout([0, 0, 10, 10], { dpi: 96 }), /no scale/);
});

const { defaultStyle, isTileJson } = plugin._internals;

const KTN = {
    tilejson: '2.2.0', name: 'basemap Vektor Kärnten', attribution: 'KAGIS', minzoom: 8, maxzoom: 17,
    tiles: ['https://gis.example/vtc/{z}/{x}/{y}.mvt'],
    vector_layers: [
        { id: 'landuse', minzoom: 8, maxzoom: 17, fields: {} },
        { id: 'gip_l', minzoom: 8, maxzoom: 17, fields: { drawclass: 'Number', feat_name: 'String' } },
        { id: 'poi', fields: { name: 'String', 'name:de': 'String' } }
    ]
};

test('defaultStyle: fills below lines below points below labels, a color per source layer', () => {
    const style = plain(defaultStyle(KTN, 'https://gis.example/basemap.json'));
    assert.deepEqual(style.layers.map(l => l.id), [
        'landuse/fill', 'gip_l/fill', 'poi/fill',
        'landuse/line', 'gip_l/line', 'poi/line',
        'landuse/circle', 'gip_l/circle', 'poi/circle',
        'gip_l/label', 'gip_l/label-line', 'poi/label', 'poi/label-line'
    ]);
    assert.deepEqual(style.sources.tilejson, {
        type: 'vector', tiles: ['https://gis.example/vtc/{z}/{x}/{y}.mvt'], minzoom: 8, maxzoom: 17, attribution: 'KAGIS'
    });
    const byId = Object.fromEntries(style.layers.map(l => [l.id, l]));
    assert.equal(byId['gip_l/line']['source-layer'], 'gip_l');
    assert.deepEqual(byId['gip_l/line'].filter, ['==', '$type', 'LineString']);
    assert.equal(byId['gip_l/line'].paint['line-color'], byId['gip_l/fill'].paint['fill-color']);
    assert.notEqual(byId['gip_l/line'].paint['line-color'], byId['landuse/line'].paint['line-color']);
    assert.equal(byId['landuse/fill'].minzoom, 8);
    assert.equal(byId['landuse/fill'].maxzoom, undefined);   // overzoomed beyond its last tiles, not hidden
    // name fields: feat_name; name:de before name; no labels without a name field
    assert.deepEqual(byId['gip_l/label'].layout['text-field'], ['get', 'feat_name']);
    assert.deepEqual(byId['poi/label'].layout['text-field'], ['get', 'name:de']);
    assert.equal(byId['gip_l/label-line'].layout['symbol-placement'], 'line');
    assert.equal(byId['landuse/label'], undefined);
});

test('defaultStyle: the geometry type filters match the decoded features', () => {
    const style = defaultStyle(KTN);
    const f = type => ({ type, properties: {} });
    const matches = (id, type) => shared.filterMatches(style.layers.find(l => l.id === id).filter, f(type), 10);
    assert.equal(matches('gip_l/fill', 'Polygon'), true);
    assert.equal(matches('gip_l/fill', 'LineString'), false);
    assert.equal(matches('gip_l/circle', 'Point'), true);
    assert.equal(matches('gip_l/label', 'Polygon'), true);
    assert.equal(matches('gip_l/label', 'Point'), true);
    assert.equal(matches('gip_l/label', 'LineString'), false);
});

test('isTileJson: a TileJSON, not a style', () => {
    assert.equal(isTileJson(KTN), true);
    assert.equal(isTileJson({ tilejson: '3.0.0' }), true);
    assert.equal(isTileJson(STYLE), false);
    assert.equal(isTileJson(null), false);
});

test('a TileJSON instead of a style: loaded with the default style, its tiles and attribution', async () => {
    const url = 'https://tiles.example/basemap.json';
    const layer = styleLayer('', { [url]: { tilejson: '2.2.0', tiles: ['x/{z}/{x}/{y}.mvt'], attribution: 'A', vector_layers: [{ id: 'roads' }] } },
        { style: url, defaultStyle: true });
    await layer._loadStyle();
    assert.deepEqual(plain(layer._style.layers.map(l => l.id)), ['roads/fill', 'roads/line', 'roads/circle']);
    assert.equal(layer._sources.tilejson.tileUrl, 'https://tiles.example/x/{z}/{x}/{y}.mvt');
    assert.equal(layer._sourceAttributions.tilejson, 'A');
    assert.equal(layer.events.at(-1).type, 'styleload');
});
