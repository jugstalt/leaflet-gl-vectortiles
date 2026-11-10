'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./helpers/load.cjs');
const { encodeTile } = require('./helpers/mvt.cjs');

const { shared } = load();

test('decodes layers, extent and properties of all value types', () => {
    const tile = shared.decodeTile(encodeTile([{
        name: 'roads', extent: 512,
        features: [{
            id: 7, type: 'LineString', geometry: [[[0, 0], [10, 0], [10, 20]]],
            properties: { name: 'Ringstraße', lanes: 4, offset: -3, width: 7.5, oneway: true, closed: false }
        }]
    }, { name: 'empty', features: [] }]));

    assert.deepEqual(Object.keys(tile).sort(), ['empty', 'roads']);
    assert.equal(tile.roads.extent, 512);
    assert.equal(tile.empty.extent, 4096);
    const f = tile.roads.features[0];
    assert.equal(f.id, 7);
    assert.equal(f.type, 'LineString');
    assert.deepEqual(plain(f.properties), { name: 'Ringstraße', lanes: 4, offset: -3, width: 7.5, oneway: true, closed: false });
});

test('decodes points, lines and polygons (multi parts, closed rings)', () => {
    const tile = shared.decodeTile(encodeTile([{
        name: 'l', features: [
            { type: 'Point', geometry: [[[1, 2], [3, 4]]] },
            { type: 'LineString', geometry: [[[0, 0], [5, 5]], [[100, 100], [90, 80], [70, 120]]] },
            { type: 'Polygon', geometry: [[[0, 0], [100, 0], [100, 100], [0, 100]], [[20, 20], [20, 80], [80, 80], [80, 20]]] }
        ]
    }]));
    const [point, line, polygon] = tile.l.features;

    assert.equal(point.type, 'Point');
    assert.deepEqual(plain(point.geometry), [[[1, 2]], [[3, 4]]]);

    assert.equal(line.type, 'LineString');
    assert.deepEqual(plain(line.geometry), [[[0, 0], [5, 5]], [[100, 100], [90, 80], [70, 120]]]);

    assert.equal(polygon.type, 'Polygon');
    assert.equal(polygon.geometry.length, 2);
    assert.ok(polygon.geometry.every(ring => ring.closed), 'rings are closed');
    assert.deepEqual(plain(polygon.geometry[1][2]), [80, 80]);
});

test('negative coordinates (buffer around the tile) and large varints', () => {
    const tile = shared.decodeTile(encodeTile([{
        name: 'l', features: [
            { id: 2 ** 40 + 5, type: 'LineString', geometry: [[[-64, -64], [4160, 4160]]], properties: { big: 2 ** 35 } }
        ]
    }]));
    const f = tile.l.features[0];
    assert.equal(f.id, 2 ** 40 + 5);
    assert.equal(f.properties.big, 2 ** 35);
    assert.deepEqual(plain(f.geometry[0]), [[-64, -64], [4160, 4160]]);
});

test('an empty buffer is a tile without layers', () => {
    assert.deepEqual(plain(shared.decodeTile(new ArrayBuffer(0))), {});
});
