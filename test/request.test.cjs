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

test('a failed tile is requested again (tileRetries), then a tileerror event', () => {
    const timers = [];
    context.setTimeout = (fn, ms) => timers.push({ fn, ms });
    const layer = layerWith({ tileRetries: 2 });
    layer._tiles = {};
    layer._tileOrder = [];
    layer._tileRetries = {};
    layer._map = {};
    layer._moving = false;
    layer.updates = 0;
    layer._update = () => { layer.updates++; };
    layer._checkLoading = () => {};
    layer.events = [];
    layer.fire = (type, data) => layer.events.push({ type, data });

    const fail = () => {
        const entry = { status: 'error', url: 'https://gview.example/t.pbf' };
        layer._tiles.k = entry;
        layer._tileOrder.push('k');
        layer._tileError('k', entry, new Error('400'));
    };
    fail();
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms >= 500 && timers[0].ms < 800);
    timers[0].fn();
    assert.equal(layer._tiles.k, undefined);   // requested again by _update
    assert.deepEqual(plain(layer._tileOrder), []);
    assert.equal(layer.updates, 1);
    fail();
    assert.ok(timers[1].ms >= 1000);
    timers[1].fn();
    assert.equal(layer.events.length, 0);
    fail();   // the third error: no more retries
    assert.equal(timers.length, 2);
    assert.equal(layer.events.length, 1);
    assert.equal(layer.events[0].type, 'tileerror');
    assert.equal(layer._tileRetries.k, undefined);
});

test('a retry is skipped when the tile was dropped meanwhile', () => {
    const timers = [];
    context.setTimeout = (fn, ms) => timers.push({ fn, ms });
    const layer = layerWith({ tileRetries: 2 });
    Object.assign(layer, { _tiles: {}, _tileOrder: [], _tileRetries: {}, _map: {}, _moving: false, _checkLoading() {} });
    let updates = 0;
    layer._update = () => { updates++; };
    const entry = { status: 'error' };
    layer._tiles.k = entry;
    layer._tileError('k', entry, new Error('x'));
    const newer = { status: 'loading' };
    layer._tiles.k = newer;
    timers[0].fn();
    assert.equal(layer._tiles.k, newer);
    assert.equal(updates, 0);
});

// _requestTiles with a stub grid: tiles are numbers on a line, `view` the visible ones; ring r adds r on each side
function requestLayer() {
    const layer = layerWith({ preload: 1 });
    layer.messages = [];
    layer._worker = { postMessage: m => layer.messages.push(plain(m)) };
    layer._sources = { s: { grid: {} } };
    layer._tiles = {};
    layer._tileOrder = [];
    layer.view = [10, 11, 12];
    layer._mapResolution = () => 1;
    layer._canvasSize = () => ({ x: 100, y: 100 });
    layer._level = () => 0;
    layer._visibleTiles = (grid, level, ring = 0) => {
        const out = [];
        for (let c = layer.view[0] - ring; c <= layer.view[layer.view.length - 1] + ring; c++) out.push({ col: c });
        return out;
    };
    layer._key = (id, t) => String(t.col);
    layer._tileEnvelope = () => ({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
    layer._toCanvas = () => ({ x: 0, y: 0 });
    layer._pump = () => {};
    layer._pruneCache = () => {};
    layer._checkLoading = () => {};
    return layer;
}
const loading = () => ({ status: 'loading', inWorker: true, used: 0, filtered: {} });
const aborts = layer => layer.messages.filter(m => m.type === 'abort').map(m => m.key);

test('requests near the view (one ring beyond the preload ring) are not aborted', () => {
    const layer = requestLayer();
    layer._tiles = { 8: loading(), 7: loading(), 30: loading() };   // 8: preload+1 ring, 7 and 30: far
    layer._moving = false;
    layer._requestTiles();
    assert.deepEqual(aborts(layer).sort(), ['30', '7']);
    assert.ok(layer._tiles[8]);
});

test('during a gesture a request is aborted only when unneeded for a while, not when the view comes back', () => {
    const layer = requestLayer();
    const vm = require('vm');
    const contextDate = vm.runInContext('Date', context);
    const realNow = contextDate.now;
    let now = 1000000;
    contextDate.now = () => now;
    try {
        layer._tiles = { 30: loading() };
        layer._moving = true;
        layer._requestTiles();
        assert.deepEqual(aborts(layer), []);   // just left the view
        now += 500;
        layer.view = [29, 30, 31];             // back again: needed, the clock starts anew
        layer._requestTiles();
        layer.view = [10, 11, 12];
        now += 600;
        layer._requestTiles();
        assert.deepEqual(aborts(layer), []);   // unneeded for 0 ms only
        now += 1000;
        layer._requestTiles();
        assert.deepEqual(aborts(layer), ['30']);
        assert.equal(layer._tiles[30], undefined);
    } finally {
        contextDate.now = realNow;
    }
});

test('at the end of a gesture requests far from the view are aborted at once', () => {
    const layer = requestLayer();
    layer._tiles = { 30: loading() };
    layer._moving = true;
    layer._requestTiles();
    layer._moving = false;
    layer._requestTiles();
    assert.deepEqual(aborts(layer), ['30']);
});

test("gpuTileRendering 'auto': GPU on WebKit (Safari, iOS), software on Chromium and Firefox", () => {
    const { prefersGpuCanvas } = plugin._internals;
    const ua = (userAgent, maxTouchPoints = 0) => ({ userAgent, maxTouchPoints });
    // WebKit: GPU
    assert.equal(prefersGpuCanvas(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')), true);
    assert.equal(prefersGpuCanvas(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1')), true);   // Chrome on iOS is WebKit
    assert.equal(prefersGpuCanvas(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15')), true);
    assert.equal(prefersGpuCanvas(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 5)), true);   // iPad
    // Chromium, Firefox: software
    assert.equal(prefersGpuCanvas(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')), false);
    assert.equal(prefersGpuCanvas(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')), false);
    assert.equal(prefersGpuCanvas(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')), false);   // Chrome on a Mac
    assert.equal(prefersGpuCanvas(ua('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 5)), false);
    assert.equal(prefersGpuCanvas(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0')), false);
    assert.equal(prefersGpuCanvas(null), false);
});

test('gpuTileRendering: true / false force it, auto asks the browser', () => {
    const layer = layerWith({ gpuTileRendering: true });
    assert.equal(layer._gpuTiles(), true);
    layer.options.gpuTileRendering = false;
    assert.equal(layer._gpuTiles(), false);
    layer.options.gpuTileRendering = 'auto';
    assert.equal(layer._gpuTiles(), false);   // no navigator in the test sandbox
});
