'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./helpers/load.cjs');

const { plugin, context } = load();
const { requestFor } = plugin._internals;

test('requestFor without transformRequest: the URL and a copy of fetchOptions', () => {
    const fetchOptions = { credentials: 'include', headers: { 'X-App': 'a' } };
    const req = requestFor(null, 'https://a.example/t/1/2/3.pbf', 'Tile', fetchOptions);
    assert.deepEqual(plain(req), { url: 'https://a.example/t/1/2/3.pbf', init: { credentials: 'include', headers: { 'X-App': 'a' } } });
    assert.notEqual(req.init, fetchOptions);
});

test('requestFor: URL, headers (added to those of fetchOptions) and fetch options from the function', () => {
    const calls = [];
    const transform = (url, type) => {
        calls.push([url, type]);
        if (url.startsWith('https://gview.example/')) return { url: url + '?token=t', headers: { Authorization: 'Bearer t' }, credentials: 'include' };
    };
    const own = requestFor(transform, 'https://gview.example/tiles/1.pbf', 'Tile', { headers: { 'X-App': 'a' } });
    assert.deepEqual(plain(own), {
        url: 'https://gview.example/tiles/1.pbf?token=t',
        init: { credentials: 'include', headers: { 'X-App': 'a', Authorization: 'Bearer t' } }
    });
    // another host: nothing returned, the request as it is (no token)
    const other = requestFor(transform, 'https://osm.example/style.json', 'Style', {});
    assert.deepEqual(plain(other), { url: 'https://osm.example/style.json', init: {} });
    assert.deepEqual(calls, [['https://gview.example/tiles/1.pbf', 'Tile'], ['https://osm.example/style.json', 'Style']]);
});

test('requestFor: headers as Headers-like object or list become a plain object (to the worker)', () => {
    const headersLike = { forEach(fn) { fn('1', 'x-a'); fn('2', 'x-b'); } };
    assert.deepEqual(plain(requestFor(() => ({ headers: headersLike }), 'u', 'Tile', {}).init.headers), { 'x-a': '1', 'x-b': '2' });
    assert.deepEqual(plain(requestFor(() => ({ headers: [['x-c', '3']] }), 'u', 'Tile', {}).init.headers), { 'x-c': '3' });
});

test('requestFor: an async transformRequest gives a Promise', async () => {
    const req = await requestFor(url => Promise.resolve({ headers: { Authorization: 'Bearer new' } }), 'u', 'Tile', {});
    assert.deepEqual(plain(req), { url: 'u', init: { headers: { Authorization: 'Bearer new' } } });
});

// a layer object without a map, a fetch stub that records the requests
function layerWith(options) {
    const layer = Object.create(plugin.prototype);
    layer.options = Object.assign({ fetchOptions: {}, transformRequest: null }, options);
    return layer;
}

test('style, source and sprite JSON requests go through transformRequest with their resource type', async () => {
    const seen = [];
    context.fetch = (url, init) => {
        seen.push({ url, init: plain(init) });
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"version":8}') });
    };
    const layer = layerWith({ transformRequest: (url, type) => ({ url: url + '#' + type, headers: { 'X-Type': type } }) });
    await layer._fetchJson('https://a.example/style.json', 'Style');
    await layer._fetchJson('https://a.example/tiles.json', 'Source');
    assert.deepEqual(seen, [
        { url: 'https://a.example/style.json#Style', init: { headers: { 'X-Type': 'Style' } } },
        { url: 'https://a.example/tiles.json#Source', init: { headers: { 'X-Type': 'Source' } } }
    ]);
});

test('an error in transformRequest rejects the request', async () => {
    const layer = layerWith({ transformRequest: () => { throw new Error('no token'); } });
    await assert.rejects(layer._fetchJson('https://a.example/style.json', 'Style'), /no token/);
});

// a layer whose tiles load in a (stub) worker
function workerLayer(transformRequest) {
    const layer = layerWith({ transformRequest });
    layer.messages = [];
    layer._worker = { postMessage: m => layer.messages.push(plain(m)) };
    layer._sources = { s: {} };
    layer._tiles = {};
    layer._tileOrder = [];
    layer._active = 0;
    layer._pending = [];
    layer.errors = [];
    layer._tileUrlFor = (source, t) => 'https://gview.example/tiles/' + t;
    layer._pump = () => {};
    layer._tileError = (key, entry, error) => layer.errors.push([key, error.message]);
    return layer;
}

test('tiles in the worker: URL and headers from transformRequest in the load message', () => {
    const layer = workerLayer(url => ({ url: url + '?token=t', headers: { Authorization: 'Bearer t' } }));
    layer._load({ key: 'k1', sourceId: 's', t: '1/2/3' });
    assert.equal(layer._active, 1);
    assert.deepEqual(layer.messages, [{
        type: 'load', key: 'k1', url: 'https://gview.example/tiles/1/2/3?token=t', sourceId: 's',
        fetchOptions: { headers: { Authorization: 'Bearer t' } }
    }]);
    assert.equal(layer._tiles.k1.url, 'https://gview.example/tiles/1/2/3?token=t');
});

test('tiles in the worker: async transformRequest, a tile aborted meanwhile is not requested', async () => {
    let release;
    const layer = workerLayer(() => new Promise(resolve => { release = resolve; }));
    layer._load({ key: 'k1', sourceId: 's', t: '1/2/3' });
    assert.equal(layer.messages.length, 0);
    delete layer._tiles.k1;   // aborted (no longer visible)
    release({ headers: { Authorization: 'Bearer t' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(layer.messages.length, 0);
    assert.equal(layer._active, 0);
});

test('tiles in the worker: an error in transformRequest is a tile error', async () => {
    const layer = workerLayer(() => Promise.reject(new Error('token expired')));
    layer._load({ key: 'k1', sourceId: 's', t: '1/2/3' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(layer.errors, [['k1', 'token expired']]);
    assert.equal(layer._active, 0);
    assert.equal(layer._tiles.k1.status, 'error');
});
