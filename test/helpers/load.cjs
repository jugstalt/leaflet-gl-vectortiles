// Loads the plugin (or its minified build) in Node: a sandbox with a minimal Leaflet stub. Enough for the shared
// code (decoder, expressions, filters, symbol anchors) and the helpers in _internals; nothing is drawn.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

function leafletStub() {
    const noop = () => {};
    const extend = props => Object.assign(function () {}, { prototype: props });
    return {
        Layer: { extend },
        Handler: { extend },
        Map: { mergeOptions: noop, addInitHook: noop },
        Util: {},
        Browser: {}
    };
}

function load(file = 'leaflet-gl-vectortiles.js') {
    const L = leafletStub();
    const quiet = Object.assign({}, console, { warn() {} });   // expected warnings (a source that fails) stay out of the output
    const context = { window: { L, location: { href: 'https://example.test/app/' }, console: quiet }, console: quiet, URL, TextDecoder, DataView, Uint8Array, ArrayBuffer };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
    const plugin = L.GLVectorTiles;
    if (!plugin) throw new Error(file + ' did not define L.GLVectorTiles');
    return { L, plugin, shared: plugin.shared() };
}

// values from the sandbox as plain values of this realm (deepStrictEqual compares prototypes)
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

module.exports = { load, plain, ROOT };
