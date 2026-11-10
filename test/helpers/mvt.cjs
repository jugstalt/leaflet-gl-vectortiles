// A small Mapbox Vector Tile encoder for the tests: tiles from plain objects.
//   encodeTile([{ name, extent, features: [{ id, type: 'Point'|'LineString'|'Polygon', properties, geometry: [[[x, y], ...], ...] }] }])
'use strict';

function varint(n, out) {
    // non-negative integers up to 2^53
    while (n >= 0x80) {
        out.push((n % 0x80) | 0x80);
        n = Math.floor(n / 0x80);
    }
    out.push(n);
    return out;
}

const zigzag = n => (n < 0 ? -2 * n - 1 : 2 * n);
const key = (tag, type, out) => varint(tag * 8 + type, out);

function bytesField(tag, bytes, out) {
    key(tag, 2, out);
    varint(bytes.length, out);
    for (const b of bytes) out.push(b);
}

const utf8 = s => Array.from(new TextEncoder().encode(s));

function packed(tag, values, out) {
    const body = [];
    for (const v of values) varint(v, body);
    bytesField(tag, body, out);
}

function encodeValue(value) {
    const out = [];
    if (typeof value === 'string') {
        bytesField(1, utf8(value), out);
    } else if (typeof value === 'boolean') {
        key(7, 0, out); varint(value ? 1 : 0, out);
    } else if (Number.isInteger(value) && value >= 0) {
        key(5, 0, out); varint(value, out);           // uint
    } else if (Number.isInteger(value)) {
        key(6, 0, out); varint(zigzag(value), out);   // sint
    } else {
        key(3, 1, out);                                // double
        const buf = new DataView(new ArrayBuffer(8));
        buf.setFloat64(0, value, true);
        for (let i = 0; i < 8; i++) out.push(buf.getUint8(i));
    }
    return out;
}

const TYPES = { Point: 1, LineString: 2, Polygon: 3 };
const command = (id, count) => (count << 3) | id;

function encodeGeometry(type, paths) {
    const out = [];
    let x = 0, y = 0;
    const move = ([px, py]) => { out.push(zigzag(px - x), zigzag(py - y)); x = px; y = py; };
    if (type === 'Point') {
        const points = paths.flat();
        out.push(command(1, points.length));
        points.forEach(move);
        return out;
    }
    for (const path of paths) {
        out.push(command(1, 1));
        move(path[0]);
        const rest = path.slice(1);
        out.push(command(2, rest.length));
        rest.forEach(move);
        if (type === 'Polygon') out.push(command(7, 1));
    }
    return out;
}

function encodeLayer(layer) {
    const keys = [], values = [], valueKeys = [];
    const keyIndex = k => { let i = keys.indexOf(k); if (i < 0) { i = keys.length; keys.push(k); } return i; };
    const valueIndex = v => {
        const id = typeof v + ':' + String(v);
        let i = valueKeys.indexOf(id);
        if (i < 0) { i = values.length; values.push(v); valueKeys.push(id); }
        return i;
    };

    const out = [];
    key(15, 0, out); varint(2, out);                    // version
    bytesField(1, utf8(layer.name), out);
    for (const f of layer.features) {
        const body = [];
        if (f.id !== undefined) { key(1, 0, body); varint(f.id, body); }
        const tags = [];
        for (const [k, v] of Object.entries(f.properties || {})) tags.push(keyIndex(k), valueIndex(v));
        if (tags.length) packed(2, tags, body);
        key(3, 0, body); varint(TYPES[f.type], body);
        packed(4, encodeGeometry(f.type, f.geometry), body);
        bytesField(2, body, out);
    }
    for (const k of keys) bytesField(3, utf8(k), out);
    for (const v of values) bytesField(4, encodeValue(v), out);
    key(5, 0, out); varint(layer.extent || 4096, out);
    return out;
}

function encodeTile(layers) {
    const out = [];
    for (const layer of layers) bytesField(3, encodeLayer(layer), out);
    return new Uint8Array(out).buffer;
}

module.exports = { encodeTile };
