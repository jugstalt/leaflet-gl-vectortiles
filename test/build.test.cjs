'use strict';
// The worker script is built from Function.toString() of the shared code and the worker main: they must not
// use anything from the plugin's closure. Checked for the source and the minified build (npm run build).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load, plain, ROOT } = require('./helpers/load.cjs');
const { encodeTile } = require('./helpers/mvt.cjs');

const MIN = 'leaflet-gl-vectortiles.min.js';

function checkSelfContained(file) {
    const { plugin } = load(file);
    // the shared code alone, in a fresh context without the plugin: as the worker gets it
    const context = { TextDecoder, DataView, Uint8Array, ArrayBuffer };
    vm.createContext(context);
    const shared = vm.runInContext('(' + plugin.shared.toString() + ')()', context);
    const tile = shared.decodeTile(encodeTile([{ name: 'l', features: [{ type: 'Point', geometry: [[[1, 2]]], properties: { a: 'b' } }] }]));
    assert.deepEqual(plain(tile.l.features[0].properties), { a: 'b' });
    assert.equal(shared.evaluateValue(['get', 'a'], tile.l.features[0], 0), 'b');
    assert.equal(typeof shared.TileRenderer, 'function');
}

test('the shared code is self-contained (the worker script)', () => checkSelfContained('leaflet-gl-vectortiles.js'));

test('the minified build loads and its worker code is self-contained', { skip: !fs.existsSync(path.join(ROOT, MIN)) && 'run npm run build first' }, () => {
    checkSelfContained(MIN);
    const { plugin } = load(MIN);
    for (const name of ['createCrs', 'decodeTile', 'evaluate', 'shared', 'SmoothWheelZoom']) {
        assert.ok(plugin[name], name);
    }
});

test('the minified build is up to date with the source (same version banner)', { skip: !fs.existsSync(path.join(ROOT, MIN)) && 'run npm run build first' }, () => {
    const source = fs.statSync(path.join(ROOT, 'leaflet-gl-vectortiles.js')).mtimeMs;
    const min = fs.statSync(path.join(ROOT, MIN)).mtimeMs;
    assert.ok(min >= source, 'leaflet-gl-vectortiles.min.js is older than the source: npm run build');
});
