'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./helpers/load.cjs');

const { plugin } = load();
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

test('cssFont: GL font names to CSS fonts', () => {
    assert.equal(cssFont(['Open Sans Bold'], 14), 'bold 14px "Open Sans", sans-serif');
    assert.equal(cssFont(['Noto Sans Italic'], 12), 'italic 12px "Noto Sans", sans-serif');
    assert.equal(cssFont(['Arial Regular'], 13.333), '13.3px "Arial", sans-serif');
    assert.equal(cssFont(null, 10), '10px "Arial", sans-serif');
});
