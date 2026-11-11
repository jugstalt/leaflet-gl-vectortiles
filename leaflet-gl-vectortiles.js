/*!
 * leaflet-gl-vectortiles
 * https://github.com/jugstalt/leaflet-gl-vectortiles
 *
 * Mapbox Vector Tiles (MVT) in Leaflet, styled with GL styles:
 * - gView vector tile caches in any projection, any scales and any tile size (`gview:grid` in the style):
 *   the map's CRS must be the projection of the cache, its zoom levels don't have to match the cache scales.
 * - classic WebMercator vector tiles (z/x/y; tiles, TileJSON or ESRI VectorTileServer sources, e.g. basemap.at)
 *   in WebMercator maps.
 *
 * - Needs only Leaflet (1.9). Maps in another projection than WebMercator use Proj4Leaflet as usual.
 * - No other dependencies: protobuf and MVT are decoded here.
 *
 * Usage:
 *   L.glVectorTiles('https://example.com/styles/root.json').addTo(map);          // any GL style
 *   L.glVectorTiles('https://server/gview/vtc/myfolder/myservice').addTo(map);   // gView vector tile service
 *
 * License: Apache-2.0
 */
(function (factory) {
    if (typeof define === 'function' && define.amd) {
        define(['leaflet'], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('leaflet'));
    } else {
        factory(window.L);
    }
}(function (L) {
    'use strict';

    // ------------------------------------------------------------------------------------------
    // Shared code: runs on the main thread and in the worker (its source is the worker script)
    // ------------------------------------------------------------------------------------------

    function gvShared() {
        'use strict';

        // ------------------------------------------------------------------------------------------
        // Protobuf / MVT decoding
        // ------------------------------------------------------------------------------------------

        function Pbf(bytes) {
            this.buf = bytes;
            this.pos = 0;
            this.length = bytes.length;
            this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        }

        Pbf.prototype = {
            readVarint: function () {
                var result = 0, shift = 0, b;
                do {
                    b = this.buf[this.pos++];
                    // beyond 28 bits: multiply, bit operations are 32 bit in JS
                    result += shift < 28 ? (b & 0x7f) << shift : (b & 0x7f) * Math.pow(2, shift);
                    shift += 7;
                } while (b >= 0x80);
                return result;
            },
            readSVarint: function () {
                var n = this.readVarint();
                return n % 2 === 1 ? (n + 1) / -2 : n / 2;
            },
            readBytes: function () {
                var end = this.readVarint() + this.pos;
                var bytes = this.buf.subarray(this.pos, end);
                this.pos = end;
                return bytes;
            },
            readString: function () {
                return new TextDecoder('utf-8').decode(this.readBytes());
            },
            readFloat: function () { var v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; },
            readDouble: function () { var v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; },
            readPacked: function () {
                var end = this.readVarint() + this.pos, values = [];
                while (this.pos < end) values.push(this.readVarint());
                return values;
            },
            skip: function (type) {
                if (type === 0) this.readVarint();
                else if (type === 1) this.pos += 8;
                else if (type === 2) this.pos = this.readVarint() + this.pos;
                else if (type === 5) this.pos += 4;
                else throw new Error('Unsupported protobuf wire type ' + type);
            },
            // calls fn(tag, type) for every field of the message ending at end
            fields: function (end, fn) {
                while (this.pos < end) {
                    var key = this.readVarint(), tag = key >> 3, type = key & 7, before = this.pos;
                    if (fn(tag, type) === false) this.skip(type);
                    else if (this.pos === before) this.skip(type);
                }
            }
        };

        var GEOMETRY_TYPES = { 1: 'Point', 2: 'LineString', 3: 'Polygon' };

        function decodeValue(pbf) {
            var end = pbf.readVarint() + pbf.pos, value = null;
            pbf.fields(end, function (tag) {
                switch (tag) {
                    case 1: value = pbf.readString(); break;
                    case 2: value = pbf.readFloat(); break;
                    case 3: value = pbf.readDouble(); break;
                    case 4: value = pbf.readVarint(); break;   // int64 (non-negative range is enough here)
                    case 5: value = pbf.readVarint(); break;
                    case 6: value = pbf.readSVarint(); break;
                    case 7: value = pbf.readVarint() !== 0; break;
                    default: return false;
                }
            });
            return value;
        }

        // MVT geometry commands → arrays of [x, y] paths (tile coordinates)
        function decodeGeometry(commands) {
            var paths = [], path = null, x = 0, y = 0, i = 0;
            while (i < commands.length) {
                var cmd = commands[i] & 0x7, count = commands[i] >> 3;
                i++;
                if (cmd === 1 || cmd === 2) {
                    for (var c = 0; c < count; c++) {
                        var dx = commands[i++], dy = commands[i++];
                        x += (dx >> 1) ^ (-(dx & 1));
                        y += (dy >> 1) ^ (-(dy & 1));
                        if (cmd === 1) {
                            path = [[x, y]];
                            paths.push(path);
                        } else {
                            path.push([x, y]);
                        }
                    }
                } else if (cmd === 7 && path) {
                    path.closed = true;
                }
            }
            return paths;
        }

        function decodeTile(arrayBuffer) {
            var pbf = new Pbf(new Uint8Array(arrayBuffer)), layers = {};

            pbf.fields(pbf.length, function (tag) {
                if (tag !== 3) return false;

                var end = pbf.readVarint() + pbf.pos;
                var layer = { name: '', extent: 4096, keys: [], values: [], features: [] }, rawFeatures = [];

                pbf.fields(end, function (ltag) {
                    switch (ltag) {
                        case 1: layer.name = pbf.readString(); break;
                        case 2: rawFeatures.push(pbf.readBytes()); break;
                        case 3: layer.keys.push(pbf.readString()); break;
                        case 4: layer.values.push(decodeValue(pbf)); break;
                        case 5: layer.extent = pbf.readVarint(); break;
                        default: return false;
                    }
                });

                rawFeatures.forEach(function (bytes) {
                    var fp = new Pbf(bytes), feature = { id: null, type: 'Unknown', properties: {}, geometry: [] };
                    fp.fields(fp.length, function (ftag) {
                        switch (ftag) {
                            case 1: feature.id = fp.readVarint(); break;
                            case 2:
                                var tags = fp.readPacked();
                                for (var t = 0; t + 1 < tags.length; t += 2) {
                                    feature.properties[layer.keys[tags[t]]] = layer.values[tags[t + 1]];
                                }
                                break;
                            case 3: feature.type = GEOMETRY_TYPES[fp.readVarint()] || 'Unknown'; break;
                            case 4: feature.geometry = decodeGeometry(fp.readPacked()); break;
                            default: return false;
                        }
                    });
                    layer.features.push(feature);
                });

                layers[layer.name] = layer;
            });

            return layers;
        }

        // ------------------------------------------------------------------------------------------
        // GL style expressions
        // ------------------------------------------------------------------------------------------

        // colors: CSS color strings ↔ [r, g, b, a] (for interpolating colors)
        var NAMED_COLORS = {
            black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1],
            yellow: [255, 255, 0, 1], orange: [255, 165, 0, 1], purple: [128, 0, 128, 1], gray: [128, 128, 128, 1],
            grey: [128, 128, 128, 1], silver: [192, 192, 192, 1], maroon: [128, 0, 0, 1], navy: [0, 0, 128, 1],
            teal: [0, 128, 128, 1], olive: [128, 128, 0, 1], lime: [0, 255, 0, 1], aqua: [0, 255, 255, 1], cyan: [0, 255, 255, 1],
            fuchsia: [255, 0, 255, 1], magenta: [255, 0, 255, 1], brown: [165, 42, 42, 1], pink: [255, 192, 203, 1],
            transparent: [0, 0, 0, 0]
        };

        function hslToRgb(h, s, l) {
            h = ((h % 360) + 360) % 360 / 360; s /= 100; l /= 100;
            var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
            var c = function (t) {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
            };
            return [c(h + 1 / 3) * 255, c(h) * 255, c(h - 1 / 3) * 255];
        }

        var colorCache = {}, colorCacheSize = 0;

        function parseColor(value) {
            if (typeof value !== 'string') return null;
            var cached = colorCache[value];
            if (cached !== undefined) return cached && cached.slice();
            if (colorCacheSize > 2000) { colorCache = {}; colorCacheSize = 0; }
            colorCacheSize++;
            var parsed = parseColorText(value);
            colorCache[value] = parsed;
            return parsed && parsed.slice();
        }

        function parseColorText(value) {
            var s = value.trim().toLowerCase();
            if (NAMED_COLORS[s]) return NAMED_COLORS[s].slice();
            var m = /^#([0-9a-f]{3,8})$/.exec(s);
            if (m) {
                var hex = m[1];
                if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(function (ch) { return ch + ch; }).join('');
                if (hex.length !== 6 && hex.length !== 8) return null;
                var n = function (i) { return parseInt(hex.substr(i, 2), 16); };
                return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
            }
            m = /^(rgba?|hsla?)\(([^)]+)\)$/.exec(s);
            if (!m) return null;
            var parts = m[2].split(/[\s,\/]+/).filter(Boolean).map(function (p) {
                return p.slice(-1) === '%' ? { v: parseFloat(p), pct: true } : { v: parseFloat(p), pct: false };
            });
            if (parts.length < 3 || parts.some(function (p) { return isNaN(p.v); })) return null;
            var alpha = parts.length > 3 ? (parts[3].pct ? parts[3].v / 100 : parts[3].v) : 1;
            if (m[1].charAt(0) === 'h') return hslToRgb(parts[0].v, parts[1].v, parts[2].v).concat([alpha]);
            return parts.slice(0, 3).map(function (p) { return p.pct ? p.v * 2.55 : p.v; }).concat([alpha]);
        }

        function formatColor(c) {
            var r = function (v) { return Math.round(Math.max(0, Math.min(255, v))); };
            return 'rgba(' + r(c[0]) + ',' + r(c[1]) + ',' + r(c[2]) + ',' + Math.round(Math.max(0, Math.min(1, c[3])) * 1000) / 1000 + ')';
        }

        // ------------------------------------------------------------------------------------------
        // Color schemes: every color of the style (and the sprite images) through one function
        // [r, g, b, a] (0–255, alpha 0–1) → [r, g, b, a]
        // ------------------------------------------------------------------------------------------

        function rgbToHsl(c) {
            var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
            var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
            if (max !== min) {
                var d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
                h *= 60;
            }
            return [h, s * 100, l * 100];
        }

        var luminance = function (c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };

        var COLOR_SCHEMES = {
            // gray tones of the same brightness
            grayscale: function (c) {
                var l = luminance(c);
                return [l, l, l, c[3]];
            },
            // the map steps back (a background for thematic data): less saturated, lighter
            pale: function (c) {
                var l = luminance(c);
                return [0, 1, 2].map(function (i) {
                    var v = c[i] + (l - c[i]) * 0.6;   // 60 % toward gray
                    return v + (255 - v) * 0.45;      // 45 % toward white
                }).concat([c[3]]);
            },
            // dark: lightness inverted, hues kept (water stays blue, forests green), half the saturation (light pastel
            // tones would turn into strong dark colors)
            dark: function (c) {
                var hsl = rgbToHsl(c);
                var l = 100 - hsl[2];
                l = 8 + l * 0.8;   // no pure black or white
                return hslToRgb(hsl[0], hsl[1] * 0.5, l).concat([c[3]]);
            },
            // high contrast (accessibility): areas and lines darker against white, text and halos black or white
            contrast: function (c, info) {
                var hsl = rgbToHsl(c), prop = info && info.property;
                // text always black on a white halo: readable on any ground (deciding each color by its own lightness
                // made light text with a light halo white on white, e.g. water labels)
                if (prop === 'text-color') return [0, 0, 0, 1];
                if (prop === 'text-halo-color') return [255, 255, 255, 1];
                // white stays white, everything else darker and more saturated: light maps (white roads on pastel
                // areas) get clearly separated areas, lines and text
                var l = Math.pow(hsl[2] / 100, 2.2);
                return hslToRgb(hsl[0], Math.min(100, hsl[1] * 1.3), l * 100).concat([c[3]]);
            },
            // red-green color blindness (deuteranopia, the most common): the colors that can't be told apart are
            // shifted into those that can (daltonization)
            colorblind: function (c) {
                var r = c[0], g = c[1], b = c[2];
                // as seen with deuteranopia (LMS simulation)
                var L = 17.8824 * r + 43.5161 * g + 4.11935 * b;
                var M = 3.45565 * r + 27.1554 * g + 3.86714 * b;
                var S = 0.0299566 * r + 0.184309 * g + 1.46709 * b;
                M = 0.494207 * L + 1.24827 * S;
                var sr = 0.0809444479 * L - 0.130504409 * M + 0.116721066 * S;
                var sg = -0.0102485335 * L + 0.0540193266 * M - 0.113614708 * S;
                var sb = -0.000365296938 * L - 0.00412161469 * M + 0.693511405 * S;
                // the difference shifted to channels that can be seen
                var er = r - sr, eg = g - sg, eb = b - sb;
                return [r, g + 0.7 * er + eg, b + 0.7 * er + eb, c[3]];
            },
            // old map: the brightness on a scale from dark brown to a muted paper tone, a little of the original color
            // kept (water and forests still recognizable)
            sepia: function (c) {
                var t = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
                var dark = [70, 52, 34], paper = [243, 234, 215];
                return [0, 1, 2].map(function (i) {
                    return (dark[i] + (paper[i] - dark[i]) * t) * 0.85 + c[i] * 0.15;
                }).concat([c[3]]);
            }
        };

        // high contrast also in sizes: lines wider, text larger, halos stronger (accessibility)
        COLOR_SCHEMES.contrast.adjust = function (name, value) {
            switch (name) {
                case 'line-width': return value > 0 ? Math.max(value * 1.3, value + 0.5) : value;
                case 'text-size': return value * 1.15;
                case 'text-halo-width': return Math.max(value * 1.5, 1.5);
                case 'icon-size': return value * 1.15;
                case 'circle-radius': return value * 1.2;
            }
            return value;
        };

        // 'tint:<color>': shades of one color (e.g. a house color), dark parts in the color, light parts toward white
        function tintScheme(color) {
            var tint = parseColor(color) || [0, 102, 204, 1];
            return function (c) {
                var l = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
                return [0, 1, 2].map(function (i) { return tint[i] * (1 - l) * 0.85 + 255 * l + tint[i] * 0.15 * l; })
                    .concat([c[3]]);
            };
        }

        // a scheme: a name ('grayscale', 'pale', 'dark') or a function (rgba, info) → rgba
        function colorSchemeFunction(scheme) {
            if (!scheme) return null;
            if (typeof scheme === 'function') return scheme;
            if (typeof scheme === 'string' && scheme.indexOf('tint:') === 0) return tintScheme(scheme.slice(5).trim());
            return COLOR_SCHEMES[scheme] || null;
        }

        // a CSS color through a scheme (colors that can't be parsed stay as they are)
        function schemeColor(color, fn, info) {
            if (!fn || typeof color !== 'string') return color;
            var c = parseColor(color);
            if (!c) return color;
            var out = fn(c, info || {});
            return out ? formatColor(out) : color;
        }

        // between two output values: numbers, colors or arrays of numbers
        function interpolateValue(a, b, t) {
            if (typeof a === 'number' && typeof b === 'number') return a + t * (b - a);
            var ca = parseColor(a), cb = parseColor(b);
            if (ca && cb) return formatColor(ca.map(function (v, i) { return v + t * (cb[i] - v); }));
            if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
                return a.map(function (v, i) { return typeof v === 'number' ? v + t * (b[i] - v) : (t < 0.5 ? v : b[i]); });
            }
            return t < 0.5 ? a : b;
        }

        // cubic-bezier(x1, y1, x2, y2) easing at x in [0, 1]
        function cubicBezier(x1, y1, x2, y2, x) {
            var bez = function (p1, p2, t) { return 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t; };
            var lo = 0, hi = 1, t = x;
            for (var i = 0; i < 30; i++) {
                var bx = bez(x1, x2, t);
                if (Math.abs(bx - x) < 1e-6) break;
                if (bx < x) lo = t; else hi = t;
                t = (lo + hi) / 2;
            }
            return bez(y1, y2, t);
        }

        function typeOf(v) {
            return v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;
        }

        function evaluate(expr, feature, zoom, scope) {
            if (!Array.isArray(expr)) return expr;

            var op = expr[0], props = feature ? feature.properties : {};
            var arg = function (i) { return evaluate(expr[i], feature, zoom, scope); };
            var num = function (i) { var v = Number(arg(i)); return isNaN(v) ? 0 : v; };

            switch (op) {
                case 'get':
                    if (expr.length > 2) { var obj = arg(2); return obj && obj[arg(1)] !== undefined ? obj[arg(1)] : null; }
                    var name = arg(1);
                    return props[name] === undefined ? null : props[name];
                case 'has': return arg(1) in props;
                case '!has': return !(arg(1) in props);
                case 'properties': return props;
                case 'id': return feature && feature.id !== undefined ? feature.id : null;
                case 'feature-state': return null;   // no feature state on a background map
                case 'literal': return expr[1];
                case 'zoom': return zoom;
                case 'geometry-type': return feature ? feature.type : null;
                case 'let':
                    var inner = Object.create(scope || null);
                    for (var lv = 1; lv + 1 < expr.length - 1; lv += 2) inner[expr[lv]] = evaluate(expr[lv + 1], feature, zoom, scope);
                    return evaluate(expr[expr.length - 1], feature, zoom, inner);
                case 'var': return scope && scope[expr[1]] !== undefined ? scope[expr[1]] : null;

                // logic, comparison
                case '!': return !arg(1);
                case 'all': for (var a = 1; a < expr.length; a++) if (!arg(a)) return false; return true;
                case 'any': for (var b = 1; b < expr.length; b++) if (arg(b)) return true; return false;
                case 'none': for (var nn = 1; nn < expr.length; nn++) if (arg(nn)) return false; return true;
                case '==': return arg(1) === arg(2);
                case '!=': return arg(1) !== arg(2);
                case '>': return arg(1) > arg(2);
                case '>=': return arg(1) >= arg(2);
                case '<': return arg(1) < arg(2);
                case '<=': return arg(1) <= arg(2);
                case 'in':
                    var needle = arg(1), haystack = arg(2);
                    if (typeof haystack === 'string') return needle !== null && haystack.indexOf(String(needle)) >= 0;
                    return Array.isArray(haystack) ? haystack.indexOf(needle) >= 0 : false;
                case 'index-of':
                    var hs = arg(2), found = hs === null || hs === undefined ? -1 : hs.indexOf(arg(1));
                    return found;
                case 'coalesce':
                    for (var co = 1; co < expr.length; co++) { var cv = arg(co); if (cv !== null && cv !== undefined) return cv; }
                    return null;

                // types
                case 'typeof': return typeOf(arg(1));
                case 'to-string':
                    var s = arg(1);
                    return s === null || s === undefined ? '' : String(s);
                case 'to-number':
                    for (var tn = 1; tn < expr.length; tn++) { var nv = Number(arg(tn)); if (arg(tn) !== null && !isNaN(nv)) return nv; }
                    return 0;
                case 'to-boolean': return !!arg(1);
                case 'to-color':
                    for (var tc = 1; tc < expr.length; tc++) { var colorValue = arg(tc); if (parseColor(colorValue)) return colorValue; }
                    return null;
                case 'string': case 'number': case 'boolean': case 'object': case 'array':
                    // type assertions: the first value of the type (else the last one)
                    for (var ta = 1; ta < expr.length; ta++) {
                        var tv = arg(ta);
                        if (typeOf(tv) === op || (op === 'array' && Array.isArray(tv))) return tv;
                    }
                    return arg(expr.length - 1);

                // strings
                case 'concat':
                    var text = '';
                    for (var c = 1; c < expr.length; c++) { var v = arg(c); text += v === null || v === undefined ? '' : String(v); }
                    return text;
                case 'upcase': return String(arg(1) === null ? '' : arg(1)).toUpperCase();
                case 'downcase': return String(arg(1) === null ? '' : arg(1)).toLowerCase();
                case 'length': var lenValue = arg(1); return lenValue === null || lenValue === undefined ? 0 : lenValue.length;
                case 'slice':
                    var sliced = arg(1);
                    return sliced === null || sliced === undefined ? null : sliced.slice(num(2), expr.length > 3 ? num(3) : undefined);
                case 'at': var atValue = arg(2); return Array.isArray(atValue) ? (atValue[num(1)] === undefined ? null : atValue[num(1)]) : null;
                case 'format':
                    // formatted text: the sections joined (font and scale of sections are not supported)
                    var formatted = '';
                    for (var f = 1; f < expr.length; f++) {
                        if (expr[f] && typeof expr[f] === 'object' && !Array.isArray(expr[f])) continue;   // section options
                        var fv = arg(f);
                        formatted += fv === null || fv === undefined ? '' : String(fv);
                    }
                    return formatted;
                case 'number-format':
                    var nf = num(1), opts = expr[2] || {};
                    var min = opts['min-fraction-digits'], max = opts['max-fraction-digits'];
                    try {
                        return nf.toLocaleString(opts.locale ? evaluate(opts.locale, feature, zoom, scope) : undefined, {
                            minimumFractionDigits: min, maximumFractionDigits: max !== undefined ? max : Math.max(min || 0, 3)
                        });
                    } catch (e) { return String(nf); }
                case 'image': return arg(1);
                case 'resolved-locale': return 'en';

                // math
                case '+': var sum = 0; for (var pl = 1; pl < expr.length; pl++) sum += num(pl); return sum;
                case '*': var product = 1; for (var ml = 1; ml < expr.length; ml++) product *= num(ml); return product;
                case '-': return expr.length > 2 ? num(1) - num(2) : -num(1);
                case '/': return num(1) / num(2);
                case '%': return num(1) % num(2);
                case '^': return Math.pow(num(1), num(2));
                case 'min': var mn = Infinity; for (var mi = 1; mi < expr.length; mi++) mn = Math.min(mn, num(mi)); return mn;
                case 'max': var mx = -Infinity; for (var ma = 1; ma < expr.length; ma++) mx = Math.max(mx, num(ma)); return mx;
                case 'abs': return Math.abs(num(1));
                case 'round': return Math.round(num(1));
                case 'floor': return Math.floor(num(1));
                case 'ceil': return Math.ceil(num(1));
                case 'sqrt': return Math.sqrt(num(1));
                case 'ln': return Math.log(num(1));
                case 'log10': return Math.log(num(1)) / Math.LN10;
                case 'log2': return Math.log(num(1)) / Math.LN2;
                case 'sin': return Math.sin(num(1));
                case 'cos': return Math.cos(num(1));
                case 'tan': return Math.tan(num(1));
                case 'pi': return Math.PI;
                case 'e': return Math.E;

                // decisions, ramps
                case 'match':
                    var input = arg(1);
                    for (var m = 2; m + 1 < expr.length; m += 2) {
                        var labels = Array.isArray(expr[m]) ? expr[m] : [expr[m]];
                        if (labels.indexOf(input) >= 0) return arg(m + 1);
                    }
                    return arg(expr.length - 1);
                case 'case':
                    for (var k = 1; k + 1 < expr.length; k += 2) if (arg(k)) return arg(k + 1);
                    return arg(expr.length - 1);
                case 'step':
                    var stepInput = arg(1), result = arg(2);
                    for (var st = 3; st + 1 < expr.length; st += 2) {
                        if (stepInput >= expr[st]) result = arg(st + 1); else break;
                    }
                    return result;
                case 'interpolate': case 'interpolate-hcl': case 'interpolate-lab':
                    var x = arg(2), stops = [];
                    for (var p = 3; p + 1 < expr.length; p += 2) stops.push([expr[p], arg(p + 1)]);
                    if (!stops.length) return null;
                    if (x <= stops[0][0]) return stops[0][1];
                    if (x >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
                    for (var q = 0; q < stops.length - 1; q++) {
                        if (x >= stops[q][0] && x <= stops[q + 1][0]) {
                            var range = stops[q + 1][0] - stops[q][0], t = range ? (x - stops[q][0]) / range : 0;
                            var type = expr[1] || ['linear'];
                            if (type[0] === 'exponential' && type[1] !== 1) {
                                t = (Math.pow(type[1], t * range) - 1) / (Math.pow(type[1], range) - 1);
                            } else if (type[0] === 'cubic-bezier') {
                                t = cubicBezier(type[1], type[2], type[3], type[4], t);
                            }
                            return interpolateValue(stops[q][1], stops[q + 1][1], t);
                        }
                    }
                    return stops[stops.length - 1][1];
                default:
                    // an array literal (dasharray, offsets, ...)
                    return expr;
            }
        }

        // legacy GL functions: { stops: [[zoom, value], ...], base, type, property, default }
        function evaluateFunction(fn, feature, zoom) {
            var stops = fn.stops || [];
            var input = fn.property ? (feature ? feature.properties[fn.property] : undefined) : zoom;

            if (fn.type === 'identity') return input === undefined ? fn['default'] : input;
            if (!stops.length) return fn['default'];

            // zoom-and-property stops ({ zoom, value }): use the zoom part only
            var key = function (s) { return typeof s[0] === 'object' && s[0] !== null ? s[0].zoom : s[0]; };

            if (fn.type === 'categorical') {
                for (var c = 0; c < stops.length; c++) if (key(stops[c]) === input) return stops[c][1];
                return fn['default'];
            }

            // numbers and colors are interpolated, anything else steps
            var numeric = typeof stops[0][1] === 'number' || !!parseColor(stops[0][1]);
            if (fn.type === 'interval' || !numeric || typeof input !== 'number') {
                var result = stops[0][1];
                for (var i = 0; i < stops.length; i++) { if (input >= key(stops[i])) result = stops[i][1]; else break; }
                return result;
            }

            // exponential (base 1 = linear)
            if (input <= key(stops[0])) return stops[0][1];
            if (input >= key(stops[stops.length - 1])) return stops[stops.length - 1][1];
            var base = fn.base || 1;
            for (var j = 0; j < stops.length - 1; j++) {
                var z0 = key(stops[j]), z1 = key(stops[j + 1]);
                if (input >= z0 && input <= z1) {
                    var t = base === 1 ? (input - z0) / (z1 - z0) : (Math.pow(base, input - z0) - 1) / (Math.pow(base, z1 - z0) - 1);
                    return interpolateValue(stops[j][1], stops[j + 1][1], t);
                }
            }
            return stops[stops.length - 1][1];
        }

        function evaluateValue(value, feature, zoom) {
            // legacy functions: with stops, or identity functions ({ type: 'identity', property })
            if (value && typeof value === 'object' && !Array.isArray(value) && (value.stops || value.type === 'identity')) {
                return evaluateFunction(value, feature, zoom);
            }
            return evaluate(value, feature, zoom);
        }

        // "{field}" tokens of legacy text-field / icon-image values
        function resolveTokens(value, feature) {
            if (typeof value !== 'string' || value.indexOf('{') < 0) return value;
            return value.replace(/\{([^}]+)\}/g, function (_, name) {
                var v = feature.properties[name];
                return v === null || v === undefined ? '' : String(v);
            });
        }

        var LEGACY_COMPARISONS = ['==', '!=', '>', '>=', '<', '<=', 'in', '!in', 'has', '!has'];

        // legacy filters (["==", "field", value], ["all", [...], ...]) or expressions
        function isLegacyFilter(filter) {
            if (!Array.isArray(filter)) return false;
            var op = filter[0];
            if (op === 'all' || op === 'any' || op === 'none') {
                return filter.length > 1 && filter.slice(1).every(isLegacyFilter);
            }
            return LEGACY_COMPARISONS.indexOf(op) >= 0 && typeof filter[1] === 'string';
        }

        function legacyFilter(filter, feature) {
            var op = filter[0];
            switch (op) {
                case 'all': for (var a = 1; a < filter.length; a++) if (!legacyFilter(filter[a], feature)) return false; return true;
                case 'any': for (var b = 1; b < filter.length; b++) if (legacyFilter(filter[b], feature)) return true; return false;
                case 'none': for (var c = 1; c < filter.length; c++) if (legacyFilter(filter[c], feature)) return false; return true;
                case 'has': return filter[1] in feature.properties;
                case '!has': return !(filter[1] in feature.properties);
            }
            var value = filter[1] === '$type' ? feature.type : filter[1] === '$id' ? feature.id : feature.properties[filter[1]];
            switch (op) {
                case '==': return value === filter[2];
                case '!=': return value !== filter[2];
                case '>': return value > filter[2];
                case '>=': return value >= filter[2];
                case '<': return value < filter[2];
                case '<=': return value <= filter[2];
                case 'in': return filter.slice(2).indexOf(value) >= 0;
                case '!in': return filter.slice(2).indexOf(value) < 0;
            }
            return false;
        }

        function filterMatches(filter, feature, zoom) {
            if (!filter) return true;
            return isLegacyFilter(filter) ? legacyFilter(filter, feature) : !!evaluate(filter, feature, zoom);
        }

        function filterUsesZoom(filter) {
            return JSON.stringify(filter || null).indexOf('"zoom"') >= 0;
        }

        // true if a paint/layout value depends on feature attributes (then features are drawn one by one)
        function isDataDriven(value) {
            if (value === null || typeof value !== 'object') return false;
            if (!Array.isArray(value)) return !!value.property || value.type === 'identity';
            var json = JSON.stringify(value);
            return json.indexOf('"get"') >= 0 || json.indexOf('"has"') >= 0 || json.indexOf('"properties"') >= 0 ||
                   json.indexOf('"geometry-type"') >= 0 || json.indexOf('"id"') >= 0 || json.indexOf('"feature-state"') >= 0;
        }

        function layerIsDataDriven(styleLayer) {
            if (styleLayer._gvDataDriven === undefined) {
                var paint = styleLayer.paint || {}, layout = styleLayer.layout || {}, driven = false;
                Object.keys(paint).forEach(function (k) { if (isDataDriven(paint[k])) driven = true; });
                Object.keys(layout).forEach(function (k) { if (isDataDriven(layout[k])) driven = true; });
                // cached on the style layer object (not part of the GL style)
                Object.defineProperty(styleLayer, '_gvDataDriven', { value: driven, enumerable: false, configurable: true });
            }
            return styleLayer._gvDataDriven;
        }

        // adds a path to the current canvas path, leaving out vertices closer than half a pixel to the last one
        // (detailed polygons at small scales: invisible, but expensive to rasterize)
        function addPath(ctx, path, tx, ty, close) {
            var n = path.length;
            if (!n) return;
            var lastX = tx(path[0]), lastY = ty(path[0]);
            ctx.moveTo(lastX, lastY);
            for (var i = 1; i < n; i++) {
                var x = tx(path[i]), y = ty(path[i]);
                if (i < n - 1 && Math.abs(x - lastX) < 0.5 && Math.abs(y - lastY) < 0.5) continue;
                ctx.lineTo(x, y);
                lastX = x; lastY = y;
            }
            if (close) ctx.closePath();
        }

        // a path offset to the side (line-offset; positive: right of the line's direction), in canvas pixels:
        // each vertex moved along the mean of the neighbor segments' normals (miter, limited)
        function addOffsetPath(ctx, path, tx, ty, offset, close) {
            var pts = [];
            for (var i = 0; i < path.length; i++) {
                var x = tx(path[i]), y = ty(path[i]), last = pts[pts.length - 1];
                if (last && Math.abs(x - last[0]) < 0.5 && Math.abs(y - last[1]) < 0.5) continue;
                pts.push([x, y]);
            }
            var n = pts.length;
            if (n < 2) return;
            var normals = [];
            for (var k = 0; k < n - 1; k++) {
                var dx = pts[k + 1][0] - pts[k][0], dy = pts[k + 1][1] - pts[k][1], len = Math.hypot(dx, dy) || 1;
                normals.push([-dy / len, dx / len]);
            }
            for (var j = 0; j < n; j++) {
                var a = normals[Math.max(0, j - 1)], b = normals[Math.min(n - 2, j)];
                var mx = a[0] + b[0], my = a[1] + b[1], ml = Math.hypot(mx, my);
                if (ml < 1e-6) { mx = b[0]; my = b[1]; ml = 1; }
                mx /= ml; my /= ml;
                var miter = Math.min(2, 1 / Math.max(0.5, mx * b[0] + my * b[1]));
                var px = pts[j][0] + mx * offset * miter, py = pts[j][1] + my * offset * miter;
                if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            if (close) ctx.closePath();
        }

        var FILL_BATCH = 16;

        // anchor points of a symbol in canvas pixels: the points, the middle of a polygon/line ('point' placement),
        // every `spacing` pixels along lines ('line') or the middle of the longest part ('line-center');
        // along lines with the angle of the line (0 with keepViewport) and the path for curved labels
        function symbolAnchors(feature, placement, spacing, keepViewport, tx, ty) {
            var anchorPoints = [];
            if (placement === 'point' || feature.type === 'Point') {
                feature.geometry.forEach(function (path) {
                    if (feature.type === 'Point') {
                        path.forEach(function (p) { anchorPoints.push({ x: tx(p), y: ty(p), angle: 0 }); });
                    } else if (path.length) {
                        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        path.forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
                        var c = [(minX + maxX) / 2, (minY + maxY) / 2];
                        anchorPoints.push({ x: tx(c), y: ty(c), angle: 0 });
                    }
                });
                return anchorPoints;
            }

            var paths = feature.geometry.map(function (path) {
                var pts = path.map(function (p) { return [tx(p), ty(p)]; }), length = 0;
                for (var i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
                return { pts: pts, length: length };
            });

            var along = function (path, distance) {
                var run = 0, pts = path.pts;
                for (var j = 1; j < pts.length; j++) {
                    var segment = Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
                    if (run + segment >= distance && segment > 0) {
                        var t = (distance - run) / segment;
                        var angle = keepViewport ? 0 : Math.atan2(pts[j][1] - pts[j - 1][1], pts[j][0] - pts[j - 1][0]);
                        if (angle > Math.PI / 2) angle -= Math.PI;
                        if (angle < -Math.PI / 2) angle += Math.PI;
                        return { x: pts[j - 1][0] + t * (pts[j][0] - pts[j - 1][0]), y: pts[j - 1][1] + t * (pts[j][1] - pts[j - 1][1]), angle: angle, lineLength: path.length, path: pts, distance: distance };
                    }
                    run += segment;
                }
                return null;
            };

            if (spacing > 0) {
                paths.forEach(function (path) {
                    if (path.length < 1) return;
                    var first = Math.min(spacing / 2, path.length / 2);
                    for (var d = first; d < path.length; d += spacing) {
                        var a = along(path, d);
                        if (a) anchorPoints.push(a);
                    }
                });
            } else {
                var longest = paths.reduce(function (best, p) { return !best || p.length > best.length ? p : best; }, null);
                if (longest && longest.length > 0) {
                    var mid = along(longest, longest.length / 2);
                    if (mid) anchorPoints.push(mid);
                }
            }
            return anchorPoints;
        }

        // symbol layers drawn into the tile images instead of the label canvas (see option iconsInTiles)
        function iconInTile(styleLayer) { return styleLayer.type === 'symbol' && !!styleLayer['gview:inTile']; }

        function makeCanvas(width, height) {
            if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
            var canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            return canvas;
        }

        // draws the geometry layers (fill, line, circle) of tiles; style and sprite are set from outside
        function TileRenderer() {
            this._style = null;
            this._sprite = null;     // { index, image, pixelRatio }
            this._patterns = {};
            this._tintedIcons = {};
        }

        TileRenderer.prototype = {
            setStyle: function (style) { this._style = style; this._patterns = {}; },
            setSprite: function (sprite) { this._sprite = sprite; this._patterns = {}; this._tintedIcons = {}; },
            setColorScheme: function (fn) { this._colorFn = fn; this._schemeCache = {}; this._patterns = {}; this._tintedIcons = {}; },
            // highlighting: style layer ids → true; the other layers dimmed with dimFn (after the color scheme)
            setHighlight: function (ids, dimFn) {
                this._highlight = ids || null;
                this._dimFn = ids ? dimFn : null;
                this._schemeCache = {};
                this._patterns = {};
            },

            // all geometry layers of a source for one tile (d: { entry, x0, y0, sx, sy, clip })
            // the geometry layers of a source for one tile, optionally only the style layers from..to (a run)
            renderTile: function (ctx, sourceId, d, zoom, from, to) {
                var self = this;
                if (from === undefined || from === null) from = 0;
                if (to === undefined || to === null) to = this._style.layers.length - 1;
                this._style.layers.forEach(function (styleLayer, layerIndex) {
                    if (layerIndex < from || layerIndex > to) return;
                    if (styleLayer.source !== sourceId || styleLayer.type === 'background') return;
                    if (styleLayer.type === 'symbol' && !iconInTile(styleLayer)) return;
                    if (!self._layerVisible(styleLayer, zoom)) return;
                    self._drawLayerTile(ctx, styleLayer, layerIndex, d, zoom, null);
                });
            },

            _layerVisible: function (styleLayer, zoom) {
                if (styleLayer.minzoom !== undefined && zoom < styleLayer.minzoom) return false;
                if (styleLayer.maxzoom !== undefined && zoom >= styleLayer.maxzoom) return false;
                return (styleLayer.layout || {}).visibility !== 'none';
            },

            // the features of one tile for one style layer: drawn on ctx, or (symbols) collected into labels
            _drawLayerTile: function (ctx, styleLayer, layerIndex, d, zoom, labels) {
                var layer = d.entry.layers[styleLayer['source-layer']];
                if (!layer) return;

                // the filtered features of a tile per style layer: filters rarely depend on the zoom
                var zoomFilter = filterUsesZoom(styleLayer.filter);
                var features = zoomFilter ? null : d.entry.filtered[layerIndex];
                if (!features) {
                    features = layer.features.filter(function (f) { return filterMatches(styleLayer.filter, f, zoom); });
                    if (!zoomFilter) d.entry.filtered[layerIndex] = features;
                }
                if (!features.length) return;

                // *-translate: the layer shifted by pixels
                var translate = this._layerTranslate(styleLayer, zoom);
                var x0 = d.x0 + translate[0], y0 = d.y0 + translate[1];
                var scaleX = d.sx / layer.extent, scaleY = d.sy / layer.extent;
                var tx = function (p) { return x0 + p[0] * scaleX; };
                var ty = function (p) { return y0 + p[1] * scaleY; };
                var self = this;

                if (styleLayer.type === 'symbol') {
                    if (labels) features.forEach(function (feature) { labels(feature, tx, ty); });
                    else if (iconInTile(styleLayer)) this._drawIcons(ctx, styleLayer, features, zoom, tx, ty);
                } else if (!layerIsDataDriven(styleLayer)) {
                    // the same style for every feature: few paths, few fill/stroke calls
                    this._drawFeatures(ctx, styleLayer, features, zoom, tx, ty);
                } else {
                    features.forEach(function (feature) { self._drawFeature(ctx, styleLayer, feature, zoom, tx, ty); });
                }
            },

            // fill-translate, line-translate, circle-translate; symbols: text-translate (or icon-translate)
            _layerTranslate: function (styleLayer, zoom) {
                var type = styleLayer.type;
                var name = type === 'symbol'
                    ? ((styleLayer.paint || {})['text-translate'] !== undefined ? 'text-translate' : 'icon-translate')
                    : type + '-translate';
                var t = this._paint(styleLayer, name, null, zoom, null);
                return Array.isArray(t) && t.length === 2 ? t : [0, 0];
            },

            _paint: function (styleLayer, name, feature, zoom, fallback) {
                var value = this._value(styleLayer, 'paint', name, feature, zoom, fallback);
                var dimmed = this._highlight && !this._highlight[styleLayer.id];
                // colors through the color scheme and, for layers not highlighted, the dimming (cached per layer
                // and color: a scheme function may depend on the layer)
                if ((this._colorFn || dimmed) && typeof value === 'string' && name.slice(-6) === '-color') {
                    var key = styleLayer.id + '|' + name + '|' + value, cached = this._schemeCache[key];
                    if (cached === undefined) {
                        var info = { property: name, layer: styleLayer.id };
                        cached = schemeColor(value, this._colorFn, info);
                        if (dimmed) cached = schemeColor(cached, this._dimFn, info);
                        this._schemeCache[key] = cached;
                    }
                    return cached;
                }
                // icons of layers not highlighted: fainter (the sprite is shared by all layers)
                if (dimmed && name === 'icon-opacity') return (typeof value === 'number' ? value : 1) * 0.35;
                // sizes through the scheme (e.g. 'contrast': wider lines, stronger halos)
                if (this._colorFn && this._colorFn.adjust && typeof value === 'number') return this._colorFn.adjust(name, value);
                return value;
            },

            _layout: function (styleLayer, name, feature, zoom, fallback) {
                var value = this._value(styleLayer, 'layout', name, feature, zoom, fallback);
                if (this._colorFn && this._colorFn.adjust && typeof value === 'number') return this._colorFn.adjust(name, value);
                return value;
            },

            // a paint/layout value; values that don't depend on the feature (constants, zoom ramps) are evaluated once
            // per style layer and zoom (cached on the style layer, not part of the GL style)
            _value: function (styleLayer, kind, name, feature, zoom, fallback) {
                var props = styleLayer[kind];
                var raw = props ? props[name] : undefined;
                if (raw === undefined) return fallback;
                if (raw === null || typeof raw !== 'object') return raw;   // a constant

                var meta = styleLayer._gvMeta;
                if (!meta) {
                    meta = {};
                    Object.defineProperty(styleLayer, '_gvMeta', { value: meta, enumerable: false, configurable: true });
                }
                var key = kind + ':' + name, entry = meta[key];
                if (!entry || entry.raw !== raw) entry = meta[key] = { raw: raw, constant: !isDataDriven(raw), zoom: null, value: null };
                if (entry.constant && entry.zoom === zoom) return entry.value;

                var value = evaluateValue(raw, feature, zoom);
                if (value === undefined || value === null) value = fallback;
                if (entry.constant) { entry.zoom = zoom; entry.value = value; }
                return value;
            },

            _path: function (ctx, feature, tx, ty, close) {
                ctx.beginPath();
                feature.geometry.forEach(function (path) {
                    addPath(ctx, path, tx, ty, close || path.closed);
                });
            },

            // all features of a tile with one style (no data driven properties) as one path
            _drawFeatures: function (ctx, styleLayer, features, zoom, tx, ty) {
                var type = styleLayer.type;

                // fills: one path with thousands of polygons is very slow to fill in browsers (nonzero over many
                // subpaths); small batches keep the number of calls low and each fill cheap
                if (type === 'fill' && features.length > FILL_BATCH) {
                    for (var b = 0; b < features.length; b += FILL_BATCH) {
                        this._drawFeatures(ctx, styleLayer, features.slice(b, b + FILL_BATCH), zoom, tx, ty);
                    }
                    return;
                }

                var wanted = type === 'fill' ? 'Polygon' : type === 'circle' ? 'Point' : null;
                var lineOffset = type === 'line' ? this._paint(styleLayer, 'line-offset', null, zoom, 0) : 0;

                ctx.beginPath();
                var any = false;
                features.forEach(function (feature) {
                    if (wanted ? feature.type !== wanted : feature.type === 'Point') return;
                    any = true;
                    if (type === 'circle') return;   // circles below
                    feature.geometry.forEach(function (path) {
                        if (lineOffset) addOffsetPath(ctx, path, tx, ty, lineOffset, path.closed);
                        else addPath(ctx, path, tx, ty, type === 'fill' || path.closed);
                    });
                });
                if (!any) return;

                switch (type) {
                    case 'fill':
                        var pattern = this._paint(styleLayer, 'fill-pattern', null, zoom, null);
                        ctx.globalAlpha = this._paint(styleLayer, 'fill-opacity', null, zoom, 1);
                        ctx.fillStyle = pattern ? (this._pattern(ctx, pattern) || 'transparent') : this._paint(styleLayer, 'fill-color', null, zoom, '#000');
                        // MVT rings have a defined winding (holes opposite): nonzero keeps overlapping features filled
                        ctx.fill('nonzero');
                        var outline = this._paint(styleLayer, 'fill-outline-color', null, zoom, null);
                        if (outline && !pattern) {
                            ctx.strokeStyle = outline;
                            ctx.lineWidth = 1;
                            ctx.stroke();
                        }
                        ctx.globalAlpha = 1;
                        break;

                    case 'line':
                        var width = this._paint(styleLayer, 'line-width', null, zoom, 1);
                        if (width <= 0) return;
                        ctx.globalAlpha = this._paint(styleLayer, 'line-opacity', null, zoom, 1);
                        var linePattern = this._paint(styleLayer, 'line-pattern', null, zoom, null);
                        ctx.strokeStyle = (linePattern && this._pattern(ctx, linePattern)) || this._paint(styleLayer, 'line-color', null, zoom, '#000');
                        ctx.lineWidth = width;
                        ctx.lineJoin = this._layout(styleLayer, 'line-join', null, zoom, 'miter');
                        ctx.lineCap = this._layout(styleLayer, 'line-cap', null, zoom, 'butt');
                        var dash = this._paint(styleLayer, 'line-dasharray', null, zoom, null);
                        ctx.setLineDash(Array.isArray(dash) ? dash.map(function (v) { return v * width; }) : []);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        ctx.globalAlpha = 1;
                        break;

                    case 'circle':
                        var radius = this._paint(styleLayer, 'circle-radius', null, zoom, 5);
                        ctx.beginPath();
                        features.forEach(function (feature) {
                            if (feature.type !== 'Point') return;
                            feature.geometry.forEach(function (path) {
                                path.forEach(function (p) {
                                    ctx.moveTo(tx(p) + radius, ty(p));
                                    ctx.arc(tx(p), ty(p), radius, 0, 2 * Math.PI);
                                });
                            });
                        });
                        ctx.globalAlpha = this._paint(styleLayer, 'circle-opacity', null, zoom, 1);
                        ctx.fillStyle = this._paint(styleLayer, 'circle-color', null, zoom, '#000');
                        ctx.fill();
                        var strokeWidth = this._paint(styleLayer, 'circle-stroke-width', null, zoom, 0);
                        if (strokeWidth > 0) {
                            ctx.globalAlpha = this._paint(styleLayer, 'circle-stroke-opacity', null, zoom, 1);
                            ctx.strokeStyle = this._paint(styleLayer, 'circle-stroke-color', null, zoom, '#000');
                            ctx.lineWidth = strokeWidth;
                            ctx.stroke();
                        }
                        ctx.globalAlpha = 1;
                        break;
                }
            },

            _drawFeature: function (ctx, styleLayer, feature, zoom, tx, ty) {
                var self = this;
                switch (styleLayer.type) {
                    case 'fill':
                        if (feature.type !== 'Polygon') return;
                        this._path(ctx, feature, tx, ty, true);
                        var pattern = this._paint(styleLayer, 'fill-pattern', feature, zoom, null);
                        ctx.globalAlpha = this._paint(styleLayer, 'fill-opacity', feature, zoom, 1);
                        ctx.fillStyle = pattern ? (this._pattern(ctx, resolveTokens(pattern, feature)) || 'transparent') : this._paint(styleLayer, 'fill-color', feature, zoom, '#000');
                        ctx.fill('evenodd');
                        var outline = this._paint(styleLayer, 'fill-outline-color', feature, zoom, null);
                        if (outline && !pattern) {
                            ctx.strokeStyle = outline;
                            ctx.lineWidth = 1;
                            ctx.stroke();
                        }
                        ctx.globalAlpha = 1;
                        break;

                    case 'line':
                        if (feature.type === 'Point') return;
                        var offset = this._paint(styleLayer, 'line-offset', feature, zoom, 0);
                        if (offset) {
                            ctx.beginPath();
                            feature.geometry.forEach(function (path) { addOffsetPath(ctx, path, tx, ty, offset, path.closed); });
                        } else {
                            this._path(ctx, feature, tx, ty, feature.type === 'Polygon');
                        }
                        var width = this._paint(styleLayer, 'line-width', feature, zoom, 1);
                        if (width <= 0) return;
                        ctx.globalAlpha = this._paint(styleLayer, 'line-opacity', feature, zoom, 1);
                        var pattern2 = this._paint(styleLayer, 'line-pattern', feature, zoom, null);
                        pattern2 = pattern2 && this._pattern(ctx, resolveTokens(pattern2, feature));
                        ctx.strokeStyle = pattern2 || this._paint(styleLayer, 'line-color', feature, zoom, '#000');
                        ctx.lineWidth = width;
                        ctx.lineJoin = this._layout(styleLayer, 'line-join', feature, zoom, 'miter');
                        ctx.lineCap = this._layout(styleLayer, 'line-cap', feature, zoom, 'butt');
                        var dash = this._paint(styleLayer, 'line-dasharray', feature, zoom, null);
                        ctx.setLineDash(Array.isArray(dash) ? dash.map(function (v) { return v * width; }) : []);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        ctx.globalAlpha = 1;
                        break;

                    case 'circle':
                        if (feature.type !== 'Point') return;
                        var radius = this._paint(styleLayer, 'circle-radius', feature, zoom, 5);
                        var strokeWidth = this._paint(styleLayer, 'circle-stroke-width', feature, zoom, 0);
                        feature.geometry.forEach(function (path) {
                            path.forEach(function (p) {
                                ctx.beginPath();
                                ctx.arc(tx(p), ty(p), radius, 0, 2 * Math.PI);
                                ctx.globalAlpha = self._paint(styleLayer, 'circle-opacity', feature, zoom, 1);
                                ctx.fillStyle = self._paint(styleLayer, 'circle-color', feature, zoom, '#000');
                                ctx.fill();
                                if (strokeWidth > 0) {
                                    ctx.globalAlpha = self._paint(styleLayer, 'circle-stroke-opacity', feature, zoom, 1);
                                    ctx.strokeStyle = self._paint(styleLayer, 'circle-stroke-color', feature, zoom, '#000');
                                    ctx.lineWidth = strokeWidth;
                                    ctx.stroke();
                                }
                            });
                        });
                        ctx.globalAlpha = 1;
                        break;
                }
            },

            // icons that may overlap anything, drawn like geometry (into the tile image)
            _drawIcons: function (ctx, styleLayer, features, zoom, tx, ty) {
                var self = this;
                features.forEach(function (feature) {
                    var name = resolveTokens(self._layout(styleLayer, 'icon-image', feature, zoom, null), feature);
                    var entry = self._spriteEntry(name);
                    if (!entry) return;
                    var placement = self._layout(styleLayer, 'symbol-placement', feature, zoom, 'point');
                    var spacing = placement === 'line' ? self._layout(styleLayer, 'symbol-spacing', feature, zoom, 250) : 0;
                    var keepViewport = self._layout(styleLayer, 'icon-rotation-alignment', feature, zoom, 'auto') === 'viewport';
                    var size = self._layout(styleLayer, 'icon-size', feature, zoom, 1);
                    var rotate = self._layout(styleLayer, 'icon-rotate', feature, zoom, 0) * Math.PI / 180;
                    var ratio = entry.pixelRatio || self._sprite.pixelRatio || 1;
                    var w = entry.width / ratio * size, h = entry.height / ratio * size;
                    var icon = self._icon(entry, name, self._paint(styleLayer, 'icon-color', feature, zoom, null));
                    ctx.globalAlpha = self._paint(styleLayer, 'icon-opacity', feature, zoom, 1);
                    symbolAnchors(feature, placement, spacing, keepViewport, tx, ty).forEach(function (a) {
                        var angle = a.angle + rotate;
                        if (angle) {
                            ctx.save();
                            ctx.translate(a.x, a.y);
                            ctx.rotate(angle);
                            ctx.drawImage(icon.source, icon.x, icon.y, entry.width, entry.height, -w / 2, -h / 2, w, h);
                            ctx.restore();
                        } else {
                            ctx.drawImage(icon.source, icon.x, icon.y, entry.width, entry.height, a.x - w / 2, a.y - h / 2, w, h);
                        }
                    });
                    ctx.globalAlpha = 1;
                });
            },

            // ---------------------------------------------------------------- sprites

            // the icon in the sprite sheet, or an SDF icon tinted with icon-color (cached): { source, x, y }
            _icon: function (entry, name, color) {
                if (!entry.sdf || !color) return { source: this._sprite.image, x: entry.x, y: entry.y };
                var key = name + '|' + color, tinted = this._tintedIcons[key];
                if (!tinted) {
                    var canvas = makeCanvas(entry.width, entry.height), c = canvas.getContext('2d');
                    c.drawImage(this._sprite.image, entry.x, entry.y, entry.width, entry.height, 0, 0, entry.width, entry.height);
                    // SDF: alpha above ~0.75 is inside the shape
                    var data = c.getImageData(0, 0, entry.width, entry.height);
                    for (var i = 3; i < data.data.length; i += 4) {
                        data.data[i] = Math.max(0, Math.min(255, Math.round((data.data[i] / 255 - 0.7) / 0.1 * 255)));
                    }
                    c.putImageData(data, 0, 0);
                    c.globalCompositeOperation = 'source-in';
                    c.fillStyle = color;
                    c.fillRect(0, 0, entry.width, entry.height);
                    tinted = this._tintedIcons[key] = { source: canvas, x: 0, y: 0 };
                }
                return tinted;
            },

            _spriteEntry: function (name) {
                return this._sprite && name && this._sprite.index[name] ? this._sprite.index[name] : null;
            },

            _pattern: function (ctx, name) {
                if (this._patterns[name] !== undefined) return this._patterns[name];
                var entry = this._spriteEntry(name);
                if (!entry) return (this._patterns[name] = null);

                var tile = makeCanvas(entry.width, entry.height);
                tile.getContext('2d').drawImage(this._sprite.image, entry.x, entry.y, entry.width, entry.height, 0, 0, entry.width, entry.height);

                var pattern = ctx.createPattern(tile, 'repeat');
                var ratio = entry.pixelRatio || this._sprite.pixelRatio;
                if (pattern && pattern.setTransform && ratio > 1) {
                    pattern.setTransform(new DOMMatrix().scale(1 / ratio));
                }
                return (this._patterns[name] = pattern);
            }
        };

        return {
            decodeTile: decodeTile, evaluate: evaluate, evaluateValue: evaluateValue, resolveTokens: resolveTokens,
            filterMatches: filterMatches, filterUsesZoom: filterUsesZoom, layerIsDataDriven: layerIsDataDriven,
            addPath: addPath, addOffsetPath: addOffsetPath, makeCanvas: makeCanvas, symbolAnchors: symbolAnchors, iconInTile: iconInTile, parseColor: parseColor,
            colorSchemeFunction: colorSchemeFunction, schemeColor: schemeColor, COLOR_SCHEMES: COLOR_SCHEMES,
            TileRenderer: TileRenderer
        };
    }

    // ------------------------------------------------------------------------------------------
    // Worker: loads, decodes, filters and renders tiles into ImageBitmaps (OffscreenCanvas)
    // ------------------------------------------------------------------------------------------

    function gvWorkerMain(shared) {
        var renderer = new shared.TileRenderer(), tiles = {}, controllers = {};

        self.onmessage = function (e) {
            var m = e.data;
            switch (m.type) {
                case 'style':
                    renderer.setStyle(m.style);
                    break;

                case 'highlight':
                    var dimFn = null;
                    try {
                        dimFn = m.dimSource ? (new Function('return (' + m.dimSource + ');'))() : shared.colorSchemeFunction(m.dim);
                    } catch (e) { dimFn = null; }
                    var ids = null;
                    if (m.ids) { ids = {}; m.ids.forEach(function (id) { ids[id] = true; }); }
                    renderer.setHighlight(ids, dimFn);
                    break;

                case 'scheme':
                    var schemeFn = null;
                    try {
                        schemeFn = m.source ? (new Function('return (' + m.source + ');'))() : shared.colorSchemeFunction(m.name);
                    } catch (e) { schemeFn = null; }
                    renderer.setColorScheme(schemeFn);
                    break;

                case 'sprite':
                    renderer.setSprite(m.sprite);
                    break;

                case 'load':
                    var controller = new AbortController();
                    controllers[m.key] = controller;
                    var options = Object.assign({}, m.fetchOptions || {}, { signal: controller.signal });
                    fetch(m.url, options)
                        .then(function (r) {
                            // 204 (gView) and 404 (ESRI, outside the data) are empty tiles
                            if (r.status === 204 || r.status === 404) return new ArrayBuffer(0);
                            if (!r.ok) throw new Error(String(r.status));
                            return r.arrayBuffer();
                        })
                        .then(function (buffer) {
                            var layers = buffer.byteLength ? shared.decodeTile(buffer) : {};
                            tiles[m.key] = { layers: layers, filtered: {}, sourceId: m.sourceId };

                            // the main thread places labels: it gets the features of each symbol layer, filtered here.
                            // Features shared by several symbol layers are sent once (structured clone keeps identity).
                            var symbolLayers = {}, filtered = {};
                            (renderer._style ? renderer._style.layers : []).forEach(function (styleLayer, layerIndex) {
                                if (styleLayer.type !== 'symbol' || styleLayer.source !== m.sourceId) return;
                                var layer = layers[styleLayer['source-layer']];
                                if (!layer) return;
                                if (shared.filterUsesZoom(styleLayer.filter)) {
                                    symbolLayers[layer.name] = layer;   // zoom dependent filter: the main thread filters itself
                                    return;
                                }
                                symbolLayers[layer.name] = symbolLayers[layer.name] || { name: layer.name, extent: layer.extent, features: [] };
                                filtered[layerIndex] = layer.features.filter(function (f) { return shared.filterMatches(styleLayer.filter, f, 0); });
                            });
                            self.postMessage({ type: 'loaded', key: m.key, layers: symbolLayers, filtered: filtered });
                        })
                        .catch(function (error) {
                            self.postMessage({ type: error && error.name === 'AbortError' ? 'aborted' : 'error', key: m.key, error: error ? String(error.message || error) : '' });
                        })
                        .then(function () { delete controllers[m.key]; });
                    break;

                case 'refilter':
                    // filters of style layers changed: cached filter results are dropped, symbol layers are
                    // filtered again for the main thread
                    Object.keys(tiles).forEach(function (key) {
                        var tile = tiles[key], filtered = {}, symbolLayers = {}, any = false;
                        m.layers.forEach(function (layerIndex) {
                            delete tile.filtered[layerIndex];
                            var styleLayer = renderer._style.layers[layerIndex];
                            if (!styleLayer || styleLayer.type !== 'symbol' || styleLayer.source !== tile.sourceId) return;
                            var layer = tile.layers[styleLayer['source-layer']];
                            if (!layer) return;
                            any = true;
                            if (shared.filterUsesZoom(styleLayer.filter)) { symbolLayers[layer.name] = layer; return; }
                            filtered[layerIndex] = layer.features.filter(function (f) { return shared.filterMatches(styleLayer.filter, f, 0); });
                        });
                        if (any) self.postMessage({ type: 'refiltered', key: key, filtered: filtered, layers: symbolLayers });
                    });
                    break;

                case 'abort':
                    if (controllers[m.key]) controllers[m.key].abort();
                    break;

                case 'drop':
                    delete tiles[m.key];
                    break;

                case 'render':
                    var tile = tiles[m.tileKey];
                    if (!tile || !renderer._style) {
                        self.postMessage({ type: 'rendered', key: m.key, bitmap: null });
                        break;
                    }
                    // Chrome/Edge rasterize a 2D OffscreenCanvas on the GPU: thousands of small paths per tile keep the
                    // GPU process busy and the page slow; in software (willReadFrequently) the worker thread does it
                    var canvas = new OffscreenCanvas(m.w, m.h), ctx = canvas.getContext('2d', m.gpu ? undefined : { willReadFrequently: true });
                    // drawing coordinates are the map canvas coordinates of the main thread, mapped to the image
                    var view = m.view, sx = m.w / view[2], sy = m.h / view[3];
                    ctx.setTransform(sx, 0, 0, sy, -view[0] * sx, -view[1] * sy);
                    var d = { entry: tile, x0: m.d.x0, y0: m.d.y0, sx: m.d.sx, sy: m.d.sy, clip: m.d.clip };
                    renderer.renderTile(ctx, m.sourceId, d, m.zoom, m.from, m.to);
                    var bitmap = canvas.transferToImageBitmap();
                    self.postMessage({ type: 'rendered', key: m.key, zoomKey: m.zoomKey, tileKey: m.tileKey, layerRect: m.layerRect, mapZoom: m.mapZoom, bitmap: bitmap }, [bitmap]);
                    break;
            }
        };
    }

    var workerUrl = null;

    // the worker script: the shared code and the worker main, as text (the plugin stays one file)
    function createWorker() {
        if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined' ||
            !OffscreenCanvas.prototype.transferToImageBitmap) {
            return null;
        }
        try {
            if (!workerUrl) {
                var source = '(' + gvWorkerMain.toString() + ')((' + gvShared.toString() + ')());';
                workerUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
            }
            return new Worker(workerUrl);
        } catch (e) {
            return null;   // e.g. a Content Security Policy without worker-src blob:
        }
    }

    var gvs = gvShared();
    var decodeTile = gvs.decodeTile, evaluateValue = gvs.evaluateValue, resolveTokens = gvs.resolveTokens;
    var symbolAnchors = gvs.symbolAnchors, iconInTile = gvs.iconInTile;
    var colorSchemeFunction = gvs.colorSchemeFunction, schemeColor = gvs.schemeColor;

    // ------------------------------------------------------------------------------------------
    // Fonts, colors
    // ------------------------------------------------------------------------------------------

    var FONT_WEIGHTS = {
        thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400,
        medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900
    };

    // a GL font name ("Open Sans Semibold Italic") → { family: 'Open Sans', weight: 600, style: 'italic' }
    function fontParts(textFont) {
        var name = (Array.isArray(textFont) ? textFont[0] : textFont) || 'Arial Regular';
        var words = String(name).split(' '), weight = 400, style = 'normal';
        while (words.length > 1) {
            var last = words[words.length - 1].toLowerCase();
            if (FONT_WEIGHTS[last]) weight = FONT_WEIGHTS[last];
            else if (last === 'italic' || last === 'oblique') style = 'italic';
            else break;
            words.pop();
        }
        return { family: words.join(' '), weight: weight, style: style };
    }

    function cssFont(textFont, size) {
        var f = fontParts(textFont);
        return (f.style === 'italic' ? 'italic ' : '') + f.weight + ' ' + Math.round(size * 10) / 10 + 'px "' + f.family + '", sans-serif';
    }

    // the URL of a web font's CSS from a template as in ol-mapbox-style ("…/{font-family}/{fontweight}{-fontstyle}.css")
    function webfontUrl(template, f) {
        return template.replace('{font-family}', f.family.toLowerCase().replace(/\s+/g, '-'))
            .replace('{fontweight}', String(f.weight))
            .replace('{-fontstyle}', f.style === 'italic' ? '-italic' : '');
    }

    // the font names a style uses (text-font of all symbol layers, also in expressions and functions)
    function styleFonts(style) {
        var fonts = {};
        var walk = function (v) {
            if (Array.isArray(v)) {
                if (v.length && v.every(function (x) { return typeof x === 'string'; }) && /\s/.test(v[0])) fonts[v[0]] = true;
                else v.forEach(walk);
            } else if (v && typeof v === 'object') {
                Object.keys(v).forEach(function (k) { walk(v[k]); });
            }
        };
        (style.layers || []).forEach(function (l) { if (l.layout && l.layout['text-font']) walk(l.layout['text-font']); });
        return Object.keys(fonts);
    }

    var loadedFontCss = {};   // web font CSS already in the page

    // ---------------------------------------------------------------- a default style for a plain TileJSON

    // well distinguishable colors, one per source layer (always the same for the same TileJSON)
    var DEFAULT_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2',
        '#7f7f7f', '#bcbd22', '#393b79', '#ad494a', '#637939', '#7b4173', '#e6550d', '#3182bd'];

    // fields that hold a name, in this order (vector_layers[].fields)
    var NAME_FIELDS = ['name:de', 'name_de', 'name', 'feat_name', 'bezeichnung', 'label', 'title', 'text', 'nam'];

    function isTileJson(json) {
        return !!json && !Array.isArray(json.layers) && (Array.isArray(json.tiles) || Array.isArray(json.vector_layers) || !!json.tilejson);
    }

    /**
     * A schematic GL style for a TileJSON without a style: per source layer (vector_layers) fill, line and circle
     * layers filtered by geometry type (vector_layers don't say which) in a color of its own, and labels where a
     * name field exists. All fills below all lines below all points and labels. Layer ids "<source layer>/fill" etc.
     */
    function defaultStyle(tilejson, url) {
        var source = { type: 'vector', tiles: tilejson.tiles || [] };
        ['minzoom', 'maxzoom', 'bounds', 'attribution', 'scheme'].forEach(function (k) {
            if (tilejson[k] !== undefined && tilejson[k] !== null) source[k] = tilejson[k];
        });
        if (!source.tiles.length && url) source = { type: 'vector', url: url };

        var vectorLayers = Array.isArray(tilejson.vector_layers) ? tilejson.vector_layers : [];
        var fills = [], lines = [], points = [], labels = [];
        vectorLayers.forEach(function (vl, i) {
            if (!vl || !vl.id) return;
            var color = DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            var base = { source: 'tilejson', 'source-layer': vl.id, metadata: { 'default-style': true } };
            if (vl.minzoom !== undefined) base.minzoom = vl.minzoom;
            var layer = function (suffix, type, filter, paint, layout) {
                var l = Object.assign({ id: vl.id + '/' + suffix, type: type, filter: filter }, base, { paint: paint });
                if (layout) l.layout = layout;
                return l;
            };
            fills.push(layer('fill', 'fill', ['==', '$type', 'Polygon'],
                { 'fill-color': color, 'fill-opacity': 0.2, 'fill-outline-color': color }));
            lines.push(layer('line', 'line', ['==', '$type', 'LineString'],
                { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 16, 2] },
                { 'line-cap': 'round', 'line-join': 'round' }));
            points.push(layer('circle', 'circle', ['==', '$type', 'Point'],
                { 'circle-color': color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2, 16, 4],
                  'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 }));

            var fields = vl.fields || {};
            var name = NAME_FIELDS.filter(function (f) { return Object.prototype.hasOwnProperty.call(fields, f); })[0];
            if (!name) return;
            var text = { 'text-color': '#333333', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 };
            labels.push(layer('label', 'symbol', ['in', '$type', 'Point', 'Polygon'], text,
                { 'text-field': ['get', name], 'text-font': ['Arial Regular'], 'text-size': 12, 'text-max-width': 8 }));
            labels.push(layer('label-line', 'symbol', ['==', '$type', 'LineString'], text,
                { 'text-field': ['get', name], 'text-font': ['Arial Regular'], 'text-size': 11, 'symbol-placement': 'line' }));
        });

        return {
            version: 8,
            name: tilejson.name || 'TileJSON',
            metadata: { 'default-style': true },
            sources: { tilejson: source },
            layers: fills.concat(lines, points, labels)
        };
    }

    // headers (a plain object, a Headers object or [[name, value]]) as a plain object
    function plainHeaders(headers) {
        var o = {};
        if (!headers) return o;
        if (Array.isArray(headers)) headers.forEach(function (h) { o[h[0]] = h[1]; });
        else if (typeof headers.forEach === 'function') headers.forEach(function (value, name) { o[name] = value; });
        else Object.assign(o, headers);
        return o;
    }

    /**
     * Option transformRequest: the URL and fetch options of a request. transform(url, resourceType) returns
     * { url, headers, credentials, ... } (any fetch option), nothing for the request as it is, or a Promise of it.
     * Its headers are added to those of fetchOptions. → { url, init } or a Promise of it.
     */
    function requestFor(transform, url, resourceType, fetchOptions) {
        var base = fetchOptions || {};
        var finish = function (t) {
            var init = Object.assign({}, base);
            if (t) {
                Object.keys(t).forEach(function (k) { if (k !== 'url' && k !== 'headers') init[k] = t[k]; });
                if (t.headers || base.headers) init.headers = Object.assign(plainHeaders(base.headers), plainHeaders(t.headers));
            } else if (base.headers) {
                init.headers = plainHeaders(base.headers);   // a plain object: also to the worker
            }
            return { url: (t && t.url) || url, init: init };
        };
        if (!transform) return finish(null);
        var t = transform(url, resourceType);
        return t && typeof t.then === 'function' ? t.then(finish) : finish(t);
    }

    // a name field (name, name_en, name:en, name:latin, name_int, …)
    var NAME_FIELD = /^name([:_](en|latin|int|nonlatin|local|[a-z]{2}))?$/;

    function localizedGet(field, lang) {
        return ['coalesce', ['get', 'name:' + lang], ['get', 'name_' + lang], ['get', field]];
    }

    // text-field with name fields preferring the language: expressions (['get', 'name']) and {name} tokens
    function localizeTextField(value, lang) {
        if (typeof value === 'string') {
            if (value.indexOf('{') < 0) return value;
            var parts = [], re = /\{([^}]+)\}/g, last = 0, m, any = false;
            while ((m = re.exec(value))) {
                if (m.index > last) parts.push(value.slice(last, m.index));
                if (NAME_FIELD.test(m[1])) { parts.push(localizedGet(m[1], lang)); any = true; }
                else parts.push(['get', m[1]]);
                last = re.lastIndex;
            }
            if (!any) return value;
            if (last < value.length) parts.push(value.slice(last));
            return parts.length === 1 ? parts[0] : ['concat'].concat(parts);
        }
        if (Array.isArray(value)) {
            if (value[0] === 'get' && value.length === 2 && typeof value[1] === 'string' && NAME_FIELD.test(value[1])) {
                return localizedGet(value[1], lang);
            }
            return value.map(function (v) { return localizeTextField(v, lang); });
        }
        return value;
    }

    // text-variable-anchor: the offset (ems) for an anchor, from text-radial-offset (or the absolute text-offset),
    // away from the anchor point in the anchor's direction
    function anchorOffset(name, radial, offset) {
        var r = radial !== null && radial !== undefined ? radial : Math.max(Math.abs(offset[0] || 0), Math.abs(offset[1] || 0));
        var d = r / Math.SQRT2;
        switch (name) {
            case 'top': return [0, r];
            case 'bottom': return [0, -r];
            case 'left': return [r, 0];
            case 'right': return [-r, 0];
            case 'top-left': return [d, d];
            case 'top-right': return [-d, d];
            case 'bottom-left': return [d, -d];
            case 'bottom-right': return [-d, -d];
        }
        return [0, 0];
    }

    // text-justify: 'auto' follows the anchor (left anchors left, right anchors right)
    function justification(justify, anchor) {
        if (justify && justify !== 'auto') return justify;
        return /left/.test(anchor || '') ? 'left' : /right/.test(anchor || '') ? 'right' : 'center';
    }

    var ANCHORS = {
        'center': [-0.5, -0.5], 'top': [-0.5, 0], 'bottom': [-0.5, -1], 'left': [0, -0.5], 'right': [-1, -0.5],
        'top-left': [0, 0], 'top-right': [-1, 0], 'bottom-left': [0, -1], 'bottom-right': [-1, -1]
    };

    // glyphs of a text along a screen path, centered at distance center: [{ ch, x, y, angle, width }] or null
    // (doesn't fit, or the line bends more than maxAngle between neighbor glyphs). Kept upright: the path is
    // walked backwards when the text would run right to left.
    function placeAlongPath(measure, text, path, center, maxAngle, letterSpacing) {
        // lengths along the path: computed once per path (several anchors of a line share it)
        var cumulative = path.gvCumulative;
        if (!cumulative) {
            cumulative = [0];
            for (var i = 1; i < path.length; i++) {
                cumulative.push(cumulative[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
            }
            Object.defineProperty(path, 'gvCumulative', { value: cumulative, enumerable: false });
        }
        var length = cumulative[cumulative.length - 1];

        var chars = Array.from(text);
        var widths = chars.map(function (ch) { return measure(ch) + letterSpacing; });
        var total = widths.reduce(function (a, b) { return a + b; }, 0) - letterSpacing;
        if (total > length) return null;

        function pointAt(distance, reversed) {
            var d = reversed ? length - distance : distance;
            if (d < 0 || d > length) return null;
            // the segment of d: binary search in the cumulative lengths
            var lo = 1, hi = path.length - 1;
            while (lo < hi) {
                var mid = (lo + hi) >> 1;
                if (cumulative[mid] >= d) hi = mid; else lo = mid + 1;
            }
            for (var j = lo; j < path.length; j++) {
                if (cumulative[j] >= d) {
                    var segment = cumulative[j] - cumulative[j - 1] || 1, t = (d - cumulative[j - 1]) / segment;
                    var a = path[j - 1], b = path[j];
                    var angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
                    if (reversed) angle += Math.PI;
                    return { x: a[0] + t * (b[0] - a[0]), y: a[1] + t * (b[1] - a[1]), angle: angle };
                }
            }
            return null;
        }

        // upright: the direction at the center decides
        var mid = pointAt(center, false);
        if (!mid) return null;
        var reversed = Math.cos(mid.angle) < 0;
        var start = (reversed ? length - center : center) - total / 2;
        if (start < 0 || start + total > length) return null;

        var glyphs = [], run = start, previous = null;
        for (var g = 0; g < chars.length; g++) {
            var at = pointAt(run + widths[g] / 2, reversed);
            if (!at) return null;
            if (previous !== null) {
                var bend = Math.abs(Math.atan2(Math.sin(at.angle - previous), Math.cos(at.angle - previous)));
                if (bend > maxAngle) return null;
            }
            previous = at.angle;
            glyphs.push({ ch: chars[g], x: at.x, y: at.y, angle: at.angle, width: widths[g] - letterSpacing });
            run += widths[g];
        }
        return glyphs;
    }

    var WEBMERCATOR_HALF = 20037508.342789244;
    var WEBMERCATOR_RES0_512 = 2 * WEBMERCATOR_HALF / 512;   // style zoom 0 (MapLibre convention: 512 px world)

    function resolveUrl(url, base) {
        try {
            // URL encodes the {z}/{x}/{y} placeholders: decode them again
            return new URL(url, base).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
        } catch (e) {
            return url;
        }
    }

    // ------------------------------------------------------------------------------------------
    // The layer
    // ------------------------------------------------------------------------------------------

    // option lowPower: fewer pixels, no redraws during gestures, less memory and parallel work
    var LOW_POWER = {
        maxPixelRatio: 1,
        padding: 0,
        liveRedrawInterval: 0,
        maxCachedTiles: 128,
        maxConcurrentRequests: 4,
        maxConcurrentRenders: 2,
        fadeDuration: 0,
        preload: 0
    };

    var GLVectorTiles = L.Layer.extend({
        options: {
            // EPSG code of a gView cache; default: the map's crs.code
            epsg: null,
            // a style URL (any GL style), instead of {url}/style.json of a gView service
            style: null,
            pane: 'overlayPane',
            // labels and icons: hide those overlapping earlier ones
            declutter: true,
            // draw the tile borders and coordinates
            debug: false,
            // tiles kept in memory (all sources)
            maxCachedTiles: 384,
            // tile requests at the same time (the nearest to the center first)
            maxConcurrentRequests: 8,
            // milliseconds per animation frame for rendering tile images (the rest in the next frames)
            renderBudget: 12,
            // render tiles in a web worker (OffscreenCanvas); falls back to the main thread where not available
            worker: true,
            // tile images rendered in the worker at the same time
            maxConcurrentRenders: 4,
            // milliseconds between redraws while the map is dragged or zoomed without animation (pinch,
            // smoothWheelZoom): tiles are loaded and drawn during the gesture; 0 = only at its end
            liveRedrawInterval: 150,
            // the canvas reaches this part of the map size beyond each edge: panning shows map there at once
            padding: 0.15,
            // render at most at this device pixel ratio (e.g. 1 on high-DPI screens: less sharp, a fraction of
            // the pixels to render); null = the screen's ratio
            maxPixelRatio: null,
            // render at exactly this pixel ratio (e.g. for printing: dpi / 96); null: the screen's (see maxPixelRatio)
            pixelRatio: null,
            // the base URL for relative URLs in a style object (default: the page)
            styleBase: null,
            // icon layers that may overlap anything (icons only, icon-allow-overlap) are drawn into the tile
            // images: much less work per frame on dense maps; they don't hide labels then (as with
            // icon-ignore-placement)
            iconsInTiles: true,
            // rings of tiles loaded around the visible ones (after them), so panning finds them loaded; 0 = none
            preload: 1,
            // render tile images on the GPU (Chrome/Edge accelerate canvases; dense vector tiles are much faster in
            // software, on the worker thread); false: software rendering
            gpuTileRendering: false,
            // web fonts for the labels: true: the style's template (metadata 'ol:webfonts'), a template of your own
            // ("https://myserver/fonts/{font-family}/{fontweight}{-fontstyle}.css"), false: system fonts only.
            // Labels are drawn at once with a fallback font and again when the fonts are loaded
            webfonts: true,
            // labels in this language where the style has name:<lang> / name_<lang> fields (e.g. 'de'); null: as styled
            language: null,
            // colors of the style (and sprite images) through a scheme: 'pale', 'grayscale', 'dark', 'contrast',
            // 'colorblind', 'sepia', 'tint:<color>' (e.g. 'tint:#1f6feb') or a function
            // (rgba, info) → rgba with rgba = [r, g, b, a] (0–255, alpha 0–1), info = { property, layer }.
            // A function must be self-contained (it is also run in the worker); null: the style's own colors
            colorScheme: null,
            // milliseconds to fade in new tiles and labels; 0 = no fading
            fadeDuration: 200,
            // economical defaults for weak clients (see LOW_POWER); options set explicitly take precedence
            lowPower: false,
            // fetch options, e.g. { credentials: 'include' } or { headers: { Authorization: ... } }
            fetchOptions: {},
            // a TileJSON instead of a style: a schematic default style from its vector_layers (false: an error)
            defaultStyle: true,
            // function (url, resourceType) per request: { url, headers, credentials, ... } (headers added to those of
            // fetchOptions), nothing for the request as it is, or a Promise of it (e.g. a token renewed first).
            // resourceType: 'Style', 'Source', 'Tile', 'SpriteJSON', 'SpriteImage', 'Font'. Called on the main thread
            transformRequest: null,
            // null: the attribution of the sources (TileJSON attribution, ESRI copyrightText)
            attribution: null,
            opacity: 1,
            zIndex: null,
            // the layer is only shown within these map zoom levels (null: always)
            minZoom: null,
            maxZoom: null
        },

        /**
         * @param url  the vtc base of a gView service (https://server/gview/vtc/[folder/]service)
         *             or the URL of any GL style (…/style.json, …/root.json)
         */
        initialize: function (url, options) {
            if (options && options.lowPower) {
                options = L.extend({}, LOW_POWER, options);
            }
            L.setOptions(this, options);
            url = url || '';
            if (/\.json(\?|$)/i.test(url) && !this.options.style) {
                this.options.style = url;
                url = '';
            }
            if (this.options.style && typeof this.options.style === 'object') {
                this._styleObject = this.options.style;
                this.options.style = null;
            }
            this._url = url.replace(/\/+$/, '');
            this._tiles = {};        // key → { status, layers, used, filtered }
            this._tileOrder = [];
            this._style = null;
            this._sources = {};      // id → { grid, zooms, tileUrl, gview, minLevel, maxLevel }
            this._sprite = null;     // { index, image, pixelRatio }
            this._patterns = {};
            this._tinted = {};
            this._renderer = new gvs.TileRenderer();
            this._worker = null;     // the render worker (one source, supported browser)
            this._rendering = {};    // image key → zoomKey of a render job running in the worker
            this._styleVersion = 0;  // incremented by style changes at runtime (part of zoomKey)
            this._images = {};       // tile images: key → { canvas, zoomKey, entry }
            this._renderQueue = {};  // tile images to (re)render: key → { sourceId, d, zoom }
            this._pending = [];      // tile requests waiting: [{ key, sourceId, t, priority }]
            this._active = 0;        // running tile requests
            this._textWidths = {};   // measureText cache: font|text → width
            this._textWidthCount = 0;
            this._placed = [];       // the labels placed at the last redraw (see _placeSymbols)
            this._visibleKeys = {};  // tile keys on the canvas (not preloaded ones)
            this._tileShownAt = {};  // tile image key → time it was first drawn (fading in)
            this._sourceAttributions = {};   // source id → attribution (HTML)
            this._autoAttribution = null;
            this._loading = false;
            this._shownIds = {};     // label text|icon → last time shown (no fading in after a zoom step)
            this._shown = {};        // label position keys shown at the last redraw: they keep their place
            this._shownZoom = null;
            this._sprites = {};      // label images: text with halo, glyphs → { canvas, w, h, pad }
            this._curvedCache = {};  // label key → image of a label along a line
            this._spriteCount = 0;
        },

        getEvents: function () {
            var events = {
                viewreset: this._reset,
                movestart: this._onMoveStart,
                zoom: this._onZoom,
                move: this._onMove,
                moveend: this._onMoveEnd,
                resize: this._resize
            };
            if (this._map.options.zoomAnimation) {
                events.zoomanim = this._onAnimZoom;
            }
            return events;
        },

        onAdd: function (map) {
            this._canvas = L.DomUtil.create('canvas', 'leaflet-gl-vectortiles leaflet-zoom-animated');
            this._canvas.style.pointerEvents = 'none';
            this.getPane().appendChild(this._canvas);
            this._ctx = this._canvas.getContext('2d');

            // labels and icons on their own canvas above the tiles: not scaled by the zoom animation, the labels
            // keep their size and only move with the map (redrawn every frame from cached label images)
            this._labelCanvas = L.DomUtil.create('canvas', 'leaflet-gl-vectortiles-labels');
            this._labelCanvas.style.pointerEvents = 'none';
            this.getPane().appendChild(this._labelCanvas);
            this._labelCtx = this._labelCanvas.getContext('2d');
            this._applyOpacity();
            this._applyZIndex();

            this._resize();
            this._ready = this._ready || this._loadStyle();
            this._ready.then(L.bind(this._update, this), L.bind(function (error) {
                this.fire('error', { error: error });
                if (window.console) console.error('leaflet-gl-vectortiles:', error);
            }, this));
        },

        onRemove: function () {
            if (this._worker) {
                this._worker.terminate();
                this._worker = null;
                this._tiles = {};
                this._tileOrder = [];
                this._images = {};
                this._rendering = {};
                this._active = 0;
                this._ready = null;   // onAdd loads the style again and starts a new worker
            }
            if (this._labelFrame) L.Util.cancelAnimFrame(this._labelFrame);
            this._labelFrame = null;
            L.DomUtil.remove(this._canvas);
            L.DomUtil.remove(this._labelCanvas);
            this._canvas = this._ctx = this._labelCanvas = this._labelCtx = null;
            this._placed = [];
        },

        getAttribution: function () {
            return this.options.attribution || this._autoAttribution;
        },

        setOpacity: function (opacity) {
            this.options.opacity = opacity;
            this._applyOpacity();
            return this;
        },

        setZIndex: function (zIndex) {
            this.options.zIndex = zIndex;
            this._applyZIndex();
            return this;
        },

        _applyOpacity: function () {
            var o = this.options.opacity === undefined || this.options.opacity === null ? 1 : this.options.opacity;
            if (this._canvas) this._canvas.style.opacity = o;
            if (this._labelCanvas) this._labelCanvas.style.opacity = o;
        },

        _applyZIndex: function () {
            var z = this.options.zIndex;
            if (this._canvas) this._canvas.style.zIndex = z === null || z === undefined ? '' : z;
            if (this._labelCanvas) this._labelCanvas.style.zIndex = z === null || z === undefined ? '' : z;
        },

        // ---------------------------------------------------------------- style at runtime

        /**
         * The style layers: [{ id, type, source, sourceLayer, visible, minzoom, maxzoom, metadata }].
         * Style layers are addressed by id, an array of ids, a RegExp (tested on the id) or a function(styleLayer).
         */
        getLayers: function () {
            return (this._style ? this._style.layers : []).map(function (l) {
                return {
                    id: l.id, type: l.type, source: l.source, sourceLayer: l['source-layer'],
                    visible: (l.layout || {}).visibility !== 'none', minzoom: l.minzoom, maxzoom: l.maxzoom, metadata: l.metadata
                };
            });
        },

        getLayerVisibility: function (id) {
            var l = this._findLayers(id)[0];
            return l ? (l.layout || {}).visibility !== 'none' : null;
        },

        setLayerVisibility: function (layers, visible) {
            return this.setLayoutProperty(layers, 'visibility', visible ? 'visible' : 'none');
        },

        setLayoutProperty: function (layers, name, value) {
            return this._changeLayers(layers, function (l) {
                l.layout = l.layout || {};
                if (value === undefined || value === null) delete l.layout[name]; else l.layout[name] = value;
            }, false);
        },

        setPaintProperty: function (layers, name, value) {
            return this._changeLayers(layers, function (l) {
                l.paint = l.paint || {};
                if (value === undefined || value === null) delete l.paint[name]; else l.paint[name] = value;
            }, false);
        },

        setFilter: function (layers, filter) {
            return this._changeLayers(layers, function (l) {
                if (filter === undefined || filter === null) delete l.filter; else l.filter = filter;
            }, true);
        },

        /** Another style: a style URL (any GL style, or a gView vtc service URL) or a style object. */
        setStyle: function (style) {
            var map = this._map;
            if (map) map.removeLayer(this);
            this._resetStyle();
            this._styleObject = null;
            this._url = '';
            this.options.style = null;
            if (style && typeof style === 'object') this._styleObject = style;
            else if (/\.json(\?|$)/i.test(style || '')) this.options.style = style;
            else this._url = (style || '').replace(/\/+$/, '');
            if (map) map.addLayer(this);
            return this;
        },

        _findLayers: function (match) {
            var layers = this._style ? this._style.layers : [];
            if (typeof match === 'function') return layers.filter(match);
            if (match instanceof RegExp) return layers.filter(function (l) { return match.test(l.id); });
            var ids = Array.isArray(match) ? match : [match];
            return layers.filter(function (l) { return ids.indexOf(l.id) >= 0; });
        },

        _changeLayers: function (match, change, filterChanged) {
            if (!this._style) throw new Error('leaflet-gl-vectortiles: the style is not loaded yet (event "styleload")');
            var layers = this._style.layers, indices = [];
            this._findLayers(match).forEach(function (l) {
                change(l);
                delete l._gvDataDriven;   // cached in the shared code
                delete l._gvMeta;
                indices.push(layers.indexOf(l));
            });
            if (indices.length) this._restyle(indices, filterChanged);
            return this;
        },

        // after changes of style layers: tile images are rendered again (the old ones stay until then), labels
        // placed again; changed filters drop the cached filter results
        _restyle: function (indices, filterChanged) {
            var self = this;
            this._markIconsInTiles(this._style);
            this._runs = this._buildRuns(this._style);
            this._applyHighlight();
            this._renderer.setStyle(this._style);
            if (this._worker) {
                this._worker.postMessage({ type: 'style', style: this._style });
                if (filterChanged) this._worker.postMessage({ type: 'refilter', layers: indices });
            }
            if (filterChanged) {
                Object.keys(this._tiles).forEach(function (key) {
                    var entry = self._tiles[key];
                    indices.forEach(function (i) { delete entry.filtered[i]; });
                });
            }
            this._styleVersion++;   // images and running render jobs of the old style are outdated
            this._curvedCache = {};   // label images with the old colors
            if (this._map) this._redraw();
        },

        // everything of the current style: setStyle loads it all again
        _resetStyle: function () {
            if (this._worker) this._worker.terminate();
            this._worker = null;
            this._ready = null;
            this._style = null;
            this._sources = {};
            this._sprite = null;
            this._patterns = {};
            this._tinted = {};
            this._renderer = new gvs.TileRenderer();
            this._tiles = {};
            this._tileOrder = [];
            this._images = {};
            this._rendering = {};
            this._renderQueue = {};
            this._pending = [];
            this._active = 0;
            this._placed = [];
            this._shown = {};
            this._shownIds = {};
            this._curvedCache = {};
            this._tileShownAt = {};
            this._visibleKeys = {};
            this._sourceAttributions = {};
            this._autoAttribution = null;
            this._loading = false;
        },

        // ---------------------------------------------------------------- attribution, loading events

        // the attribution of the sources, if the layer has none of its own
        _updateAttribution: function () {
            var seen = {}, self = this;
            var text = Object.keys(this._sourceAttributions).map(function (id) { return self._sourceAttributions[id]; })
                .filter(function (a) { if (!a || seen[a]) return false; seen[a] = true; return true; }).join(' | ') || null;
            var old = this._autoAttribution;
            this._autoAttribution = text;
            var control = this._map && this._map.attributionControl;
            if (this.options.attribution || !control || old === text) return;
            if (old) control.removeAttribution(old);
            if (text) control.addAttribution(text);
        },

        // 'loading' when visible tiles start to load, 'load' when all visible tiles are loaded and rendered
        _checkLoading: function (startOnly) {
            // busy: render jobs running in the worker or still queued (sent a few at a time)
            var busy = Object.keys(this._rendering).length > 0 || Object.keys(this._renderQueue).length > 0, visible = this._visibleKeys;
            for (var key in visible) {
                var entry = this._tiles[key];
                if (!entry || entry.status === 'loading') { busy = true; break; }
            }
            if (busy && !this._loading) {
                this._loading = true;
                this.fire('loading');
            } else if (!busy && this._loading && !startOnly) {
                this._loading = false;
                this.fire('load');
            }
        },

        _tileError: function (key, entry, error) {
            this.fire('tileerror', { key: key, url: entry && entry.url, error: error });
            this._checkLoading();
        },

        /** The loaded GL style (after the 'styleload' event). */
        getStyle: function () { return this._style; },

        /** The tile grid of the (first) gView source: { epsg, origin, resolutions, tileSize, extent, webmercator }. */
        getGrid: function () {
            for (var id in this._sources) if (this._sources[id].gview) return this._sources[id].grid;
            var first = this._sources[Object.keys(this._sources)[0]];
            return first ? first.grid : null;
        },

        // ---------------------------------------------------------------- style, sources, sprite

        // the URL and fetch options of a request (option transformRequest): { url, init }, or a Promise of it
        _request: function (url, resourceType) {
            return requestFor(this.options.transformRequest, url, resourceType, this.options.fetchOptions);
        },

        // the same, always as a Promise (also for an error thrown by transformRequest)
        _requestAsync: function (url, resourceType) {
            var self = this;
            return new Promise(function (resolve) { resolve(self._request(url, resourceType)); });
        },

        _fetch: function (url, resourceType) {
            return this._requestAsync(url, resourceType).then(function (req) {
                return fetch(req.url, req.init).then(function (response) {
                    if (!response.ok) throw new Error(response.status + ' ' + url);
                    return response;
                });
            });
        },

        _fetchJson: function (url, resourceType) {
            var self = this;
            return this._fetch(url, resourceType).then(function (r) { return r.text(); }).then(function (text) {
                try {
                    return JSON.parse(text);
                } catch (e) {
                    // an ESRI service root answers HTML without f=json
                    if (url.indexOf('f=json') < 0) {
                        return self._fetchJson(url + (url.indexOf('?') < 0 ? '?' : '&') + 'f=json', resourceType);
                    }
                    throw new Error('No JSON: ' + url);
                }
            });
        },

        _loadStyle: function () {
            var epsg = this.options.epsg || this._mapEpsg();
            var styleUrl = this.options.style || (this._url + '/style.json' + (epsg ? '?epsg=' + epsg : ''));
            styleUrl = resolveUrl(styleUrl, window.location.href);
            var self = this;
            // relative URLs in a style object: to its base (default the page)
            if (this._styleObject) styleUrl = resolveUrl(this.options.styleBase || window.location.href, window.location.href);

            var loading;
            if (this._styleObject) {
                loading = Promise.resolve(this._styleObject);
            } else if (this.options.style) {
                loading = this._fetchJson(styleUrl, 'Style');
            } else {
                // a gView vtc base: {url}/style.json; otherwise the URL may be a style itself without .json at its end
                // (e.g. https://tiles.openfreemap.org/styles/liberty)
                var direct = resolveUrl(this._url, window.location.href);
                loading = this._fetchJson(styleUrl, 'Style').catch(function (error) {
                    return self._fetchJson(direct, 'Style').then(function (style) {
                        if (!style || (!Array.isArray(style.layers) && !(self.options.defaultStyle && isTileJson(style)))) throw error;
                        styleUrl = direct;
                        return style;
                    }, function () { throw error; });
                });
            }

            return loading
                .then(function (style) {
                    if (self.options.defaultStyle && isTileJson(style)) style = defaultStyle(style, styleUrl);
                    if (!style || !Array.isArray(style.layers)) {
                        throw new Error(style && (style.tiles || style.tilejson || style.vector_layers)
                            ? 'A TileJSON, not a GL style (no layers): ' + styleUrl
                            : 'Not a GL style (no layers): ' + styleUrl);
                    }
                    self._style = style;
                    self._styleUrl = styleUrl;   // the base of its relative URLs (see toImage)
                    self._renderer.setColorScheme(colorSchemeFunction(self.options.colorScheme));
                    self._applyHighlight();
                    self._markIconsInTiles(style);
                    self._runs = self._buildRuns(style);
                    self._renderer.setStyle(style);
                    var gviewGrid = (style.metadata || {})['gview:grid'] || null;

                    var used = {};
                    style.layers.forEach(function (l) { if (l.source) used[l.source] = true; });

                    return Promise.all(Object.keys(style.sources || {})
                        .filter(function (id) { return used[id] && style.sources[id].type === 'vector'; })
                        .map(function (id) {
                            // a source that can't be loaded: an error event, the other sources are drawn
                            return self._loadSource(id, style.sources[id], styleUrl, gviewGrid).catch(function (error) {
                                self.fire('error', { error: error, source: id });
                                if (window.console) console.warn('leaflet-gl-vectortiles: source "' + id + '":', error);
                            });
                        }));
                })
                .then(function () {
                    self._updateAttribution();
                    self._loadWebfonts(self._style, styleUrl);
                    return self._loadSprite(self._style.sprite, styleUrl);
                })
                .then(function () { return self._startWorker(); })
                .then(function () { self.fire('styleload', { style: self._style }); });
        },

        _loadSource: function (id, source, styleUrl, gviewGrid) {
            var self = this, mapEpsg = this._mapEpsg();

            // gView cache: its own grid (any projection)
            if (gviewGrid && source.tiles) {
                if (mapEpsg && String(gviewGrid.epsg) !== String(mapEpsg)) {
                    return Promise.reject(new Error('The map is EPSG:' + mapEpsg + ', the tile cache EPSG:' + gviewGrid.epsg));
                }
                var zooms = gviewGrid.webmercator
                    ? gviewGrid.resolutions.map(function (r) { return Math.round(Math.log(156543.03392804097 / (r * gviewGrid.tileSize[0] / 256)) / Math.LN2); })
                    : gviewGrid.resolutions.map(function (r, i) { return i; });
                if (source.attribution) this._sourceAttributions[id] = source.attribution;
                this._sources[id] = {
                    gview: true, grid: gviewGrid, zooms: zooms, tileUrl: resolveUrl(source.tiles[0], styleUrl),
                    minLevel: 0, maxLevel: gviewGrid.resolutions.length - 1
                };
                return Promise.resolve();
            }

            // classic source: WebMercator z/x/y, tiles direct or from a TileJSON / ESRI VectorTileServer
            if (mapEpsg && mapEpsg !== '3857' && mapEpsg !== '900913') {
                return Promise.reject(new Error('Source "' + id + '" is a WebMercator vector tile source, the map is EPSG:' + mapEpsg));
            }

            var resolved = source.tiles
                ? Promise.resolve({ tiles: source.tiles.map(function (t) { return resolveUrl(t, styleUrl); }), info: source })
                : this._fetchJson(resolveUrl(source.url, styleUrl), 'Source').then(function (info) {
                    var base = resolveUrl(source.url, styleUrl);
                    // a service URL (ESRI VectorTileServer) is a "directory": its tiles are relative to it;
                    // a TileJSON file (…/tiles.json) is a file: its tiles are relative to its folder
                    var path = base.split('?')[0];
                    if (!/\/$/.test(path) && !/\.[a-z0-9]+$/i.test(path.split('/').pop())) base = path + '/';
                    return { tiles: (info.tiles || []).map(function (t) { return resolveUrl(t, base); }), info: info };
                });

            return resolved.then(function (r) {
                var info = r.info || {};
                // TileJSON: attribution (HTML); ESRI: copyrightText (text)
                var attribution = source.attribution || info.attribution ||
                    (info.copyrightText ? String(info.copyrightText).replace(/[&<>"]/g, function (c) {
                        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
                    }) : null);
                if (attribution) self._sourceAttributions[id] = attribution;
                var tileSize = source.tileSize || (info.tileInfo && info.tileInfo.rows) || info.tileSize || 512;
                var minLevel = source.minzoom !== undefined ? source.minzoom : (info.minzoom || 0);
                // ESRI: tiles exist up to maxLOD (the style's maxzoom is the display limit)
                var maxLevel = info.maxLOD !== undefined ? info.maxLOD
                    : source.maxzoom !== undefined ? source.maxzoom
                    : info.maxzoom !== undefined ? info.maxzoom : 14;

                var resolutions = [], zooms = [];
                for (var z = 0; z <= maxLevel; z++) {
                    resolutions.push(2 * WEBMERCATOR_HALF / (tileSize * Math.pow(2, z)));
                    zooms.push(z + Math.log(tileSize / 512) / Math.LN2);
                }

                if (!r.tiles.length) throw new Error('Source "' + id + '" has no tile URLs');

                self._sources[id] = {
                    gview: false,
                    grid: {
                        epsg: 3857, origin: [-WEBMERCATOR_HALF, WEBMERCATOR_HALF], resolutions: resolutions,
                        tileSize: [tileSize, tileSize], extent: [-WEBMERCATOR_HALF, -WEBMERCATOR_HALF, WEBMERCATOR_HALF, WEBMERCATOR_HALF],
                        webmercator: true
                    },
                    zooms: zooms, tileUrl: r.tiles[0], minLevel: minLevel, maxLevel: maxLevel
                };
            });
        },

        // the style's sprite: a URL, or (style spec v8) a list [{ id, url }] whose icons are named "id:icon" (the id
        // "default" without prefix). Several sprites are put into one image (one atlas for the worker).
        _loadSprite: function (sprite, styleUrl) {
            var list = typeof sprite === 'string' ? [{ id: 'default', url: sprite }] : Array.isArray(sprite) ? sprite : [];
            if (!list.length) return Promise.resolve();
            var ratio = this._ratio() > 1 ? 2 : 1, suffix = ratio === 2 ? '@2x' : '';
            var self = this;

            var loadOne = function (entry) {
                var url = resolveUrl(entry.url, styleUrl), parts = url.split('?'), query = parts[1] ? '?' + parts[1] : '';
                return self._fetchJson(parts[0] + suffix + '.json' + query, 'SpriteJSON')
                    .then(function (index) {
                        return self._requestAsync(parts[0] + suffix + '.png' + query, 'SpriteImage').then(function (req) {
                            // with headers: fetched (an <img> can't send them), the image from the blob
                            var withHeaders = req.init.headers && Object.keys(req.init.headers).length > 0;
                            var src = withHeaders
                                ? fetch(req.url, req.init).then(function (response) {
                                    if (!response.ok) throw new Error(response.status + ' ' + req.url);
                                    return response.blob();
                                }).then(function (blob) { return URL.createObjectURL(blob); })
                                : Promise.resolve(req.url);
                            return src.then(function (url) {
                                return new Promise(function (resolve) {
                                    var image = new Image();
                                    image.crossOrigin = req.init.credentials === 'include' ? 'use-credentials' : 'anonymous';
                                    image.onload = function () {
                                        if (withHeaders) URL.revokeObjectURL(url);
                                        resolve({ id: entry.id, index: index, image: image });
                                    };
                                    image.onerror = function () { resolve(null); };
                                    image.src = url;
                                });
                            });
                        });
                    })
                    .catch(function () { return null; });   // without this sprite
            };

            return Promise.all(list.map(loadOne)).then(function (sprites) {
                sprites = sprites.filter(Boolean);
                if (!sprites.length) return;
                var image = sprites[0].image, index = {};
                if (sprites.length > 1) {
                    // one atlas: the sprite images below each other
                    var width = 0, height = 0;
                    sprites.forEach(function (sp) { width = Math.max(width, sp.image.width); height += sp.image.height; });
                    image = document.createElement('canvas');
                    image.width = width;
                    image.height = height;
                    var ctx = image.getContext('2d'), y = 0;
                    sprites.forEach(function (sp) { ctx.drawImage(sp.image, 0, y); sp.offset = y; y += sp.image.height; });
                }
                sprites.forEach(function (sp) {
                    var prefix = sp.id === 'default' ? '' : sp.id + ':';
                    Object.keys(sp.index).forEach(function (name) {
                        var entry = L.extend({}, sp.index[name]);
                        entry.y += sp.offset || 0;
                        index[prefix + name] = entry;
                    });
                });
                self._spriteOriginal = image;
                self._sprite = { index: index, image: self._schemeImage(image), pixelRatio: ratio };
                self._renderer.setSprite(self._sprite);
            });
        },

        // the sprite image through the color scheme (pixel by pixel, once per scheme)
        _schemeImage: function (image) {
            var fn = colorSchemeFunction(this.options.colorScheme);
            if (!fn || !image) return image;
            var canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            var ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(image, 0, 0);
            var data;
            try { data = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (e) { return image; }   // tainted
            var px = data.data, c = [0, 0, 0, 0], info = { property: 'icon-image' };
            for (var i = 0; i < px.length; i += 4) {
                if (px[i + 3] === 0) continue;
                c[0] = px[i]; c[1] = px[i + 1]; c[2] = px[i + 2]; c[3] = px[i + 3] / 255;
                var out = fn(c, info);
                if (!out) continue;
                px[i] = out[0]; px[i + 1] = out[1]; px[i + 2] = out[2];
            }
            ctx.putImageData(data, 0, 0);
            return canvas;
        },

        // the scheme to the renderer and the worker (a function is sent as its source)
        _applyColorScheme: function () {
            var scheme = this.options.colorScheme;
            this._renderer.setColorScheme(colorSchemeFunction(scheme));
            if (this._worker) {
                this._worker.postMessage(typeof scheme === 'function'
                    ? { type: 'scheme', source: scheme.toString() }
                    : { type: 'scheme', name: scheme || null });
            }
        },

        /**
         * Another color scheme at runtime: 'grayscale', 'pale', 'dark', a function (rgba, info) → rgba, or null for the
         * style's own colors.
         */
        setColorScheme: function (scheme) {
            this.options.colorScheme = scheme || null;
            var self = this;
            this._applyColorScheme();
            this._applyHighlight();
            // label images, icons and the sprite with the new colors
            this._sprites = {};
            this._spriteCount = 0;
            this._curvedCache = {};
            this._tinted = {};
            if (this._sprite && this._spriteOriginal) {
                Object.keys(this._sprite.index).forEach(function (name) { delete self._sprite.index[name].icon; });
                this._sprite.image = this._schemeImage(this._spriteOriginal);
                this._renderer.setSprite(this._sprite);
                this._sendSprite();
            }
            this._styleVersion++;   // tile images rendered again
            if (this._map) this._redraw();
            return this;
        },

        getColorScheme: function () { return this.options.colorScheme; },

        /**
         * Highlights style layers (id, ids, RegExp or function, as setLayerVisibility): the others are dimmed with a
         * color scheme (options.dim, default 'pale'; 'grayscale', 'dark', ... or a function) and their icons fainter.
         * highlight(null) shows all layers normally again.
         */
        highlight: function (layers, options) {
            if (layers === null || layers === undefined || layers === false) {
                this._highlight = null;
            } else {
                var dim = (options && options.dim) || 'pale';
                this._highlight = { match: layers, dim: dim };
            }
            this._applyHighlight();
            this._restyleColors();
            return this;
        },

        // the highlighted style layer ids (resolved against the current style), to the renderer and the worker
        _applyHighlight: function () {
            var h = this._highlight, ids = null, dim = null;
            if (h && this._style) {
                ids = this._findLayers(h.match).map(function (l) { return l.id; });
                dim = h.dim;
            }
            var set = null;
            if (ids) { set = {}; ids.forEach(function (id) { set[id] = true; }); }
            this._renderer.setHighlight(set, colorSchemeFunction(dim));
            if (this._worker) {
                this._worker.postMessage(typeof dim === 'function'
                    ? { type: 'highlight', ids: ids, dimSource: dim.toString() }
                    : { type: 'highlight', ids: ids, dim: dim });
            }
        },

        // colors changed (highlight): label images and tile images again, the sprite stays
        _restyleColors: function () {
            this._sprites = {};
            this._spriteCount = 0;
            this._curvedCache = {};
            this._styleVersion++;
            if (this._map) this._redraw();
        },

        _sendSprite: function () {
            var worker = this._worker, sprite = this._sprite;
            if (!worker || !sprite) return Promise.resolve();
            return createImageBitmap(sprite.image).then(function (bitmap) {
                worker.postMessage({ type: 'sprite', sprite: { index: sprite.index, image: bitmap, pixelRatio: sprite.pixelRatio } }, [bitmap]);
            });
        },

        _mapEpsg: function () {
            var code = this._map && this._map.options.crs && this._map.options.crs.code;
            var match = /EPSG:(\d+)/i.exec(code || '');
            return match ? match[1] : null;
        },

        // ---------------------------------------------------------------- worker

        _startWorker: function () {
            if (!this.options.worker || !Object.keys(this._sources).length) return null;
            var worker = createWorker();
            if (!worker) return null;

            var self = this;

            worker.onmessage = function (e) { self._onWorkerMessage(e.data); };
            worker.onerror = function () { self._stopWorker(); };   // fall back to the main thread
            worker.postMessage({ type: 'style', style: this._style });

            this._worker = worker;
            this._applyColorScheme();
            this._applyHighlight();

            // the sprite (icons, patterns) before the first render job
            if (!this._sprite) return null;
            return this._sendSprite();
        },

        _stopWorker: function () {
            if (!this._worker) return;
            this._worker.terminate();
            this._worker = null;
            // tiles of the worker have no geometry on the main thread: load them again
            this._tiles = {};
            this._tileOrder = [];
            this._images = {};
            this._rendering = {};
            this._active = 0;
            this._update();
        },

        _onWorkerMessage: function (m) {
            var entry = this._tiles[m.key];
            switch (m.type) {
                case 'loaded':
                    this._active--;
                    if (entry) {
                        // symbol layers only, already filtered: the geometry stays in the worker
                        entry.layers = m.layers;
                        entry.filtered = m.filtered;
                        entry.status = 'loaded';
                        if (this._visibleKeys[m.key]) this._scheduleRedraw();   // preloaded: drawn when visible
                    }
                    this._pump();
                    break;
                case 'error':
                    this._active--;
                    if (entry) {
                        entry.status = 'error';
                        this._tileError(m.key, entry, new Error(m.error || 'tile request failed'));
                    }
                    this._pump();
                    break;
                case 'refiltered':
                    if (entry && entry.layers) {
                        for (var i in m.filtered) entry.filtered[i] = m.filtered[i];
                        for (var name in m.layers) entry.layers[name] = m.layers[name];
                        this._scheduleRedraw();
                    }
                    break;
                case 'aborted':
                    this._active--;
                    this._pump();
                    break;
                case 'rendered':
                    delete this._rendering[m.key];
                    if (m.bitmap) {
                        var old = this._images[m.key];
                        if (old && old.canvas.close) old.canvas.close();
                        this._images[m.key] = { canvas: m.bitmap, zoomKey: m.zoomKey, entry: this._tiles[m.tileKey], layerRect: m.layerRect, mapZoom: m.mapZoom };
                    }
                    this._scheduleRedraw();
                    this._checkLoading();
                    break;
            }
        },

        // the tile canvas as it is now (before a redraw clears it), with the map pixels and zoom it shows
        _keepFrame: function () {
            if (this._frameZoom === undefined || this._frameZoom === null || !this._canvas.width) return null;
            var keep = this._frameCanvas || (this._frameCanvas = document.createElement('canvas'));
            if (keep.width !== this._canvas.width || keep.height !== this._canvas.height) {
                keep.width = this._canvas.width;
                keep.height = this._canvas.height;
            }
            var c = keep.getContext('2d');
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.clearRect(0, 0, keep.width, keep.height);
            c.drawImage(this._canvas, 0, 0);
            return { canvas: keep, global: this._frameGlobal, zoom: this._frameZoom, ratio: this._ratio() };
        },

        // a kept frame at the current zoom and position
        _drawFrame: function (ctx, frame, rects) {
            var map = this._map, scale = map.getZoomScale(map.getZoom(), frame.zoom);
            var origin = this._layerOrigin().add(map.getPixelOrigin());
            ctx.save();
            ctx.beginPath();
            rects.forEach(function (r) { ctx.rect(r[0], r[1], r[2], r[3]); });
            ctx.clip();
            ctx.drawImage(frame.canvas, frame.global.x * scale - origin.x, frame.global.y * scale - origin.y,
                frame.canvas.width / frame.ratio * scale, frame.canvas.height / frame.ratio * scale);
            ctx.restore();
        },

        // fading in: the opacity of a tile image (first drawn at _tileShownAt[key])
        _tileAlpha: function (key, now) {
            var duration = this.options.fadeDuration;
            if (!(duration > 0)) return 1;
            var since = this._tileShownAt[key];
            if (since === undefined) since = this._tileShownAt[key] = now;
            return Math.min(1, (now - since) / duration);
        },

        // the next frame of a tile fading in: tiles only, labels are not placed again
        _requestFadeFrame: function () {
            if (this._fadeFrame) return;
            this._fadeFrame = L.Util.requestAnimFrame(function () {
                this._fadeFrame = null;
                if (!this._map || this._map._animatingZoom) return;
                this._fadeRedraw = true;
                try { this._redraw(); } finally { this._fadeRedraw = false; }
            }, this);
        },

        _dropImage: function (key) {
            delete this._tileShownAt[key];
            var image = this._images[key];
            if (image && image.canvas.close) image.canvas.close();
            delete this._images[key];
        },

        // icon layers that may overlap anything (icons only, icon-allow-overlap): drawn into the tile images
        // runs: consecutive style layers of one source drawn into the tile images (geometry, icons in tiles), in
        // style order. With one source there is one run; styles with several sources get one image per run and tile.
        _buildRuns: function (style) {
            var runs = [], current = null;
            style.layers.forEach(function (l, i) {
                if (!l.source || l.type === 'background' || (l.type === 'symbol' && !iconInTile(l))) return;
                if (current && current.source === l.source) { current.to = i; return; }
                current = { source: l.source, from: i, to: i, index: runs.length };
                runs.push(current);
            });
            return runs;
        },

        // web fonts: the CSS of each font the style uses (a <link> per URL, once per page), then the labels again
        _loadWebfonts: function (style, styleUrl) {
            var option = this.options.webfonts;
            var template = typeof option === 'string' ? option
                : option ? (style.metadata || {})['ol:webfonts'] : null;
            if (!template || typeof document === 'undefined' || !document.fonts) return;
            var self = this, loads = [];
            styleFonts(style).forEach(function (name) {
                var f = fontParts(name);
                var url = resolveUrl(webfontUrl(template, f), styleUrl);
                if (!loadedFontCss[url]) {
                    // a <link>: transformRequest can change its URL and credentials, not send headers
                    loadedFontCss[url] = self._requestAsync(url, 'Font').then(function (req) {
                        return new Promise(function (resolve) {
                            var link = document.createElement('link');
                            link.rel = 'stylesheet';
                            link.href = req.url;
                            link.crossOrigin = req.init.credentials === 'include' ? 'use-credentials' : 'anonymous';
                            link.onload = resolve;
                            link.onerror = resolve;   // without this font: the fallback stays
                            document.head.appendChild(link);
                        });
                    }).catch(function () {});
                }
                loads.push(loadedFontCss[url].then(function () {
                    return document.fonts.load((f.style === 'italic' ? 'italic ' : '') + f.weight + ' 16px "' + f.family + '"')
                        .catch(function () { return []; });
                }));
            });
            if (!loads.length) return;
            Promise.all(loads).then(function () {
                if (!self._map || !self._labelCtx) return;
                // widths and label images of the fallback font are outdated
                self._textWidths = {};
                self._textWidthCount = 0;
                self._sprites = {};
                self._spriteCount = 0;
                self._curvedCache = {};
                if (!self._moving) self._redraw();
            });
        },

        // option language: name fields of text-field (name, name_en, name:latin, …) preferring name:<lang> /
        // name_<lang>; the original kept to switch the language again
        _localize: function (style) {
            var lang = this.options.language;
            style.layers.forEach(function (l) {
                if (l.type !== 'symbol' || !l.layout || l.layout['text-field'] === undefined) return;
                if (l['gview:textField'] === undefined) l['gview:textField'] = l.layout['text-field'];
                l.layout['text-field'] = lang ? localizeTextField(l['gview:textField'], lang) : l['gview:textField'];
            });
        },

        /** Labels in another language ('de', 'en', …; null: as in the style), for styles with name:<lang> fields. */
        setLanguage: function (lang) {
            this.options.language = lang || null;
            if (this._style) {
                this._localize(this._style);
                this._renderer.setStyle(this._style);
                if (this._worker) this._worker.postMessage({ type: 'style', style: this._style });
                this._sprites = {};
                this._spriteCount = 0;
                this._curvedCache = {};
                this._shownIds = {};
                if (this._map) this._redraw();
            }
            return this;
        },

        _markIconsInTiles: function (style) {
            this._localize(style);
            // 3D buildings (fill-extrusion) seen from above: flat fills with their color and opacity
            style.layers.forEach(function (l) {
                if (l.type !== 'fill-extrusion') return;
                var paint = l.paint || {};
                l.type = 'fill';
                l['gview:extrusion'] = true;
                l.paint = { 'fill-color': paint['fill-extrusion-color'] !== undefined ? paint['fill-extrusion-color'] : '#000' };
                if (paint['fill-extrusion-opacity'] !== undefined) l.paint['fill-opacity'] = paint['fill-extrusion-opacity'];
                if (paint['fill-extrusion-pattern'] !== undefined) l.paint['fill-pattern'] = paint['fill-extrusion-pattern'];
            });

            var on = this.options.iconsInTiles;
            style.layers.forEach(function (l) {
                var layout = l.layout || {};
                l['gview:inTile'] = !!(on && l.type === 'symbol' && layout['icon-image'] && !layout['text-field'] &&
                    layout['icon-allow-overlap'] === true);
            });
        },

        // device pixels per CSS pixel to render with
        _ratio: function () {
            if (this.options.pixelRatio > 0) return this.options.pixelRatio;
            var ratio = window.devicePixelRatio || 1, max = this.options.maxPixelRatio;
            return max > 0 ? Math.min(ratio, max) : ratio;
        },

        // the canvas: the map size plus padding on each side; its top left corner in layer pixels
        _pad: function () {
            return this._map.getSize().multiplyBy(this.options.padding || 0).round();
        },

        _canvasSize: function () {
            return this._map.getSize().add(this._pad().multiplyBy(2));
        },

        _layerOrigin: function () {
            return this._map.containerPointToLayerPoint(this._pad().multiplyBy(-1));
        },

        // ---------------------------------------------------------------- canvas placement (as L.Renderer)

        _resize: function () {
            if (!this._canvas) return;
            var size = this._canvasSize(), ratio = this._ratio();
            this._canvas.width = Math.round(size.x * ratio);
            this._canvas.height = Math.round(size.y * ratio);
            this._canvas.style.width = size.x + 'px';
            this._canvas.style.height = size.y + 'px';
            this._labelCanvas.width = this._canvas.width;
            this._labelCanvas.height = this._canvas.height;
            this._labelCanvas.style.width = size.x + 'px';
            this._labelCanvas.style.height = size.y + 'px';
            this._update();
        },

        _reset: function () { this._update(); },

        _onZoom: function () {
            this._updateTransform(this._map.getCenter(), this._map.getZoom());
            this._paintLabels();

            this._liveRedraw();
        },

        // dragging, pinching, smooth wheel zoom move the map frame by frame: load and draw now and then
        // during a gesture (dragging, wheel, pinch, animated zoom) tiles are loaded and finished tile images drawn,
        // labels only move with the map; at its end everything is drawn once, labels placed again
        _onMoveStart: function () {
            this._moving = true;
        },

        _onMoveEnd: function () {
            this._moving = false;
            this._update();
        },

        _liveRedraw: function () {
            var interval = this.options.liveRedrawInterval;
            if (interval > 0 && !this._map._animatingZoom && Date.now() - (this._lastLive || 0) >= interval) {
                this._lastLive = Date.now();
                this._update();   // during a gesture: tiles only (see _redraw)
            }
        },

        _onAnimZoom: function (e) {
            this._updateTransform(e.center, e.zoom);
            this._animateLabels();
        },

        // during a zoom animation (a CSS transition of the tile canvas) the labels follow it frame by frame
        _animateLabels: function () {
            if (this._labelFrame) return;
            var self = this, until = Date.now() + 400;
            (function frame() {
                self._labelFrame = null;
                if (!self._labelCanvas) return;
                self._paintLabels();
                if (Date.now() < until || (self._map && self._map._animatingZoom)) self._labelFrame = L.Util.requestAnimFrame(frame);
            })();
        },

        // the current transform of the tile canvas (also in the middle of a CSS transition): canvas pixel → layer pixel
        _canvasTransform: function () {
            var m = /matrix(3d)?\(([^)]+)\)/.exec(window.getComputedStyle(this._canvas).transform || '');
            if (!m) {
                var pos = L.DomUtil.getPosition(this._canvas) || L.point(0, 0);
                return { a: 1, e: pos.x, f: pos.y };
            }
            var v = m[2].split(',').map(parseFloat);
            return m[1] ? { a: v[0], e: v[12], f: v[13] } : { a: v[0], e: v[4], f: v[5] };
        },

        _updateTransform: function (center, zoom) {
            if (!this._center) return;
            var map = this._map,
                scale = map.getZoomScale(zoom, this._zoom),
                viewHalf = map.getSize().multiplyBy(0.5).add(this._pad()),
                currentCenterPoint = map.project(this._center, zoom),
                topLeftOffset = viewHalf.multiplyBy(-scale).add(currentCenterPoint).subtract(map._getNewPixelOrigin(center, zoom));

            if (L.Browser.any3d) {
                L.DomUtil.setTransform(this._canvas, topLeftOffset, scale);
            } else {
                L.DomUtil.setPosition(this._canvas, topLeftOffset);
            }
        },

        _validResolution: function () {
            var res = this._mapResolution();
            return isFinite(res) && res > 0;
        },

        _update: function () {
            if (!this._map || !this._canvas || !this._style || !this._validResolution()) return;
            if (this._outsideZoom()) {
                this._clearCanvases();
                return;
            }
            this._requestTiles();
            this._redraw();
        },

        // outside the layer's minZoom/maxZoom: nothing drawn, nothing loaded
        _outsideZoom: function () {
            var z = this._map.getZoom(), o = this.options;
            return (o.minZoom !== null && o.minZoom !== undefined && z < o.minZoom) ||
                (o.maxZoom !== null && o.maxZoom !== undefined && z > o.maxZoom);
        },

        _clearCanvases: function () {
            [this._ctx, this._labelCtx].forEach(function (ctx) {
                if (!ctx) return;
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            });
            this._placed = [];
            this._visibleKeys = {};
            this._pending = [];
            if (this._loading) { this._loading = false; this.fire('load'); }
        },

        // panning (dragging, inertia): the canvases move with the map pane, labels are not placed again
        _isPanning: function () {
            var map = this._map, drag = map.dragging && map.dragging._draggable;
            return !!((drag && drag._moving) || (map._panAnim && map._panAnim._inProgress));
        },

        _onMove: function () {
            var interval = this.options.liveRedrawInterval;
            if (!this._canvasOrigin || this._map.getZoom() !== this._zoom || !(interval > 0)) return;   // zoom: _onZoom
            if (Date.now() - (this._lastLive || 0) < interval) return;
            this._lastLive = Date.now();
            this._requestTiles();
            // the canvas moves with the map: redraw only when the padding is about to run out
            // (new tiles redraw when they arrive)
            var moved = this._layerOrigin().subtract(this._canvasOrigin), pad = this._pad();
            if (Math.abs(moved.x) > pad.x / 2 || Math.abs(moved.y) > pad.y / 2) this._redraw();
        },

        // ---------------------------------------------------------------- grid math

        // map pixel resolution in CRS units per pixel (Leaflet's EPSG:3857 has a scale factor in its transformation)
        _mapResolution: function () {
            var crs = this._map.options.crs;
            var factor = crs.transformation && crs.transformation._a ? Math.abs(crs.transformation._a) : 1;
            return 1 / (crs.scale(this._map.getZoom()) * factor);
        },

        // the level to draw: nearest resolution (as OpenLayers), within the source's tile levels
        _level: function (source, resolution) {
            if (!source.gview) {
                // GL clients load the tiles of floor(zoom), and classic styles are made for that: a style layer
                // starting at zoom 16 shows data that only the level 16 tiles contain
                var zoom = this._styleZoom(source, resolution);
                var level = source.minLevel;
                for (var z = source.minLevel; z <= source.maxLevel && z < source.zooms.length; z++) {
                    if (source.zooms[z] <= zoom + 1e-6) level = z;
                }
                return level;
            }

            var res = source.grid.resolutions, best = source.minLevel, bestDiff = Infinity;
            for (var i = source.minLevel; i <= source.maxLevel && i < res.length; i++) {
                var diff = Math.abs(Math.log(res[i] / resolution));
                if (diff < bestDiff) { bestDiff = diff; best = i; }
            }
            return best;
        },

        // the (fractional) style zoom of a resolution
        _styleZoom: function (source, resolution) {
            if (!source.gview) {
                // MapLibre convention, independent of the tile size
                return Math.log(WEBMERCATOR_RES0_512 / resolution) / Math.LN2;
            }
            var res = source.grid.resolutions, zooms = source.zooms, n = res.length;
            if (n === 1) return zooms[0];
            if (resolution >= res[0]) return zooms[0] - Math.log(resolution / res[0]) / Math.log(res[0] / res[1]) * (zooms[1] - zooms[0]);
            for (var i = 0; i < n - 1; i++) {
                if (resolution <= res[i] && resolution >= res[i + 1]) {
                    return zooms[i] + Math.log(res[i] / resolution) / Math.log(res[i] / res[i + 1]) * (zooms[i + 1] - zooms[i]);
                }
            }
            return zooms[n - 1] + Math.log(res[n - 1] / resolution) / Math.log(res[n - 2] / res[n - 1]) * (zooms[n - 1] - zooms[n - 2]);
        },

        // world (CRS) → canvas pixel
        _toCanvas: function (x, y) {
            var map = this._map, crs = map.options.crs;
            var p = crs.transformation.transform(L.point(x, y), crs.scale(map.getZoom()));
            return p.subtract(map.getPixelOrigin()).subtract(this._layerOrigin());
        },

        // canvas pixel → world (CRS)
        _toWorld: function (px, py) {
            var map = this._map, crs = map.options.crs;
            var p = L.point(px, py).add(this._layerOrigin()).add(map.getPixelOrigin());
            return crs.transformation.untransform(p, crs.scale(map.getZoom()));
        },

        _tileEnvelope: function (grid, level, row, col) {
            var res = grid.resolutions[level];
            var w = grid.tileSize[0] * res, h = grid.tileSize[1] * res;
            var minX = grid.origin[0] + col * w, maxY = grid.origin[1] - row * h;
            return { minX: minX, minY: maxY - h, maxX: minX + w, maxY: maxY };
        },

        // the tiles of a level on the canvas, or with `ring` > 0 that many tiles more around it
        _visibleTiles: function (grid, level, ring) {
            var size = this._canvasSize(), res = grid.resolutions[level];
            var m = ring ? ring * grid.tileSize[0] * res / this._mapResolution() : 0;   // tile size in pixels
            var a = this._toWorld(-m, -m), b = this._toWorld(size.x + m, size.y + m);
            var minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);

            if (grid.extent) {
                minX = Math.max(minX, grid.extent[0]); minY = Math.max(minY, grid.extent[1]);
                maxX = Math.min(maxX, grid.extent[2]); maxY = Math.min(maxY, grid.extent[3]);
                if (minX >= maxX || minY >= maxY) return [];
            }

            var w = grid.tileSize[0] * res, h = grid.tileSize[1] * res;
            var col0 = Math.floor((minX - grid.origin[0]) / w), col1 = Math.floor((maxX - grid.origin[0]) / w);
            var row0 = Math.floor((grid.origin[1] - maxY) / h), row1 = Math.floor((grid.origin[1] - minY) / h);

            var tiles = [];
            if ((col1 - col0 + 1) * (row1 - row0 + 1) > 400) return tiles;   // safety: zoomed far out
            for (var r = row0; r <= row1; r++) {
                for (var c = col0; c <= col1; c++) {
                    if (r >= 0 && c >= 0) tiles.push({ level: level, row: r, col: c });
                }
            }
            return tiles;
        },

        // ---------------------------------------------------------------- tile loading

        _key: function (sourceId, t) { return sourceId + '|' + t.level + '/' + t.row + '/' + t.col; },

        _tileUrlFor: function (source, t) {
            // {z}: the scale index of a custom gView grid, the zoom level of a WebMercator cache
            var z = source.gview ? source.zooms[t.level] : t.level;
            return source.tileUrl
                .replace('{z}', z)
                .replace('{x}', t.col)
                .replace('{y}', t.row);
        },

        _requestTiles: function () {
            var resolution = this._mapResolution(), self = this;
            var size = this._canvasSize(), cx = size.x / 2, cy = size.y / 2;
            var wanted = {}, pending = [], visible = {};

            Object.keys(this._sources).forEach(function (id) {
                var source = self._sources[id];
                var level = self._level(source, resolution);
                self._visibleTiles(source.grid, level).forEach(function (t) {
                    var key = self._key(id, t);
                    wanted[key] = visible[key] = true;
                    if (self._tiles[key]) {
                        self._tiles[key].used = Date.now();
                        return;
                    }

                    // the nearest tiles to the center of the map first
                    var env = self._tileEnvelope(source.grid, t.level, t.row, t.col);
                    var p = self._toCanvas((env.minX + env.maxX) / 2, (env.minY + env.maxY) / 2);
                    pending.push({ key: key, sourceId: id, t: t, priority: Math.hypot(p.x - cx, p.y - cy) });
                });

                // preloading: the tiles around the canvas, after the visible ones
                if (!(self.options.preload > 0)) return;
                self._visibleTiles(source.grid, level, self.options.preload).forEach(function (t) {
                    var key = self._key(id, t);
                    if (wanted[key]) return;
                    wanted[key] = true;
                    if (self._tiles[key]) return;
                    var env = self._tileEnvelope(source.grid, t.level, t.row, t.col);
                    var p = self._toCanvas((env.minX + env.maxX) / 2, (env.minY + env.maxY) / 2);
                    pending.push({ key: key, sourceId: id, t: t, priority: 1e7 + Math.hypot(p.x - cx, p.y - cy) });
                });
            });

            // requests for tiles that are no longer visible (fast zooming or panning) are aborted
            Object.keys(this._tiles).forEach(function (key) {
                var entry = self._tiles[key];
                if (entry.status === 'loading' && !wanted[key]) {
                    if (entry.inWorker && self._worker) self._worker.postMessage({ type: 'abort', key: key });
                    else if (entry.controller) entry.controller.abort();
                    else return;
                    delete self._tiles[key];
                }
            });

            pending.sort(function (a, b) { return a.priority - b.priority; });
            this._visibleKeys = visible;
            this._pending = pending;
            this._pump();
            this._pruneCache();
            this._checkLoading(true);
        },

        _pump: function () {
            var self = this;
            while (this._active < this.options.maxConcurrentRequests && this._pending.length) {
                var job = this._pending.shift();
                if (this._tiles[job.key]) continue;
                this._load(job);
            }
        },

        _load: function (job) {
            var self = this, source = this._sources[job.sourceId];

            if (this._worker) {
                var url = this._tileUrlFor(source, job.t);
                var workerEntry = this._tiles[job.key] = { status: 'loading', layers: null, used: Date.now(), filtered: {}, inWorker: true, url: url };
                this._tileOrder.push(job.key);
                this._active++;
                // transformRequest runs here (it may use the page's variables, e.g. a token), the worker only fetches
                var send = function (req) {
                    if (self._tiles[job.key] !== workerEntry || !self._worker) {   // aborted meanwhile (async transform)
                        self._active--;
                        self._pump();
                        return;
                    }
                    workerEntry.url = req.url;
                    self._worker.postMessage({ type: 'load', key: job.key, url: req.url, sourceId: job.sourceId, fetchOptions: req.init });
                };
                var fail = function (error) {
                    self._active--;
                    if (self._tiles[job.key] === workerEntry) {
                        workerEntry.status = 'error';
                        self._tileError(job.key, workerEntry, error);
                    }
                    self._pump();
                };
                var req;
                try { req = this._request(url, 'Tile'); } catch (e) { fail(e); return; }
                if (req && typeof req.then === 'function') req.then(send, fail); else send(req);
                return;
            }

            var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var entry = this._tiles[job.key] = { status: 'loading', layers: null, used: Date.now(), filtered: {}, controller: controller, url: this._tileUrlFor(source, job.t) };
            this._tileOrder.push(job.key);
            this._active++;

            this._requestAsync(entry.url, 'Tile')
                .then(function (req) {
                    entry.url = req.url;
                    var options = Object.assign({}, req.init);
                    if (controller) options.signal = controller.signal;
                    return fetch(req.url, options);
                })
                .then(function (r) {
                    // 204 (gView) and 404 (ESRI, outside the data) are empty tiles
                    if (r.status === 204 || r.status === 404) return new ArrayBuffer(0);
                    if (!r.ok) throw new Error(r.status);
                    return r.arrayBuffer();
                })
                .then(function (buffer) {
                    entry.layers = buffer.byteLength ? decodeTile(buffer) : {};
                    entry.status = 'loaded';
                    entry.controller = null;
                    self._scheduleRedraw();
                })
                .catch(function (error) {
                    var aborted = error && error.name === 'AbortError';
                    entry.status = 'error';
                    entry.controller = null;
                    if (!aborted && self._tiles[job.key] === entry) self._tileError(job.key, entry, error);
                })
                .then(function () {
                    self._active--;
                    self._pump();
                });
        },

        _pruneCache: function () {
            var max = this.options.maxCachedTiles;
            if (this._tileOrder.length <= max) return;
            var self = this;
            this._tileOrder.sort(function (a, b) { return (self._tiles[a] ? self._tiles[a].used : 0) - (self._tiles[b] ? self._tiles[b].used : 0); });
            while (this._tileOrder.length > max) {
                var key = this._tileOrder.shift();
                delete this._tiles[key];
                if (this._worker) this._worker.postMessage({ type: 'drop', key: key });
            }
        },

        // redraws for arriving tiles and images: coalesced, at most every ~100 ms (a redraw places all labels)
        _scheduleRedraw: function () {
            if (this._redrawRequested) return;
            this._redrawRequested = true;
            var wait = Math.max(0, 100 - (Date.now() - (this._lastRedraw || 0)));
            setTimeout(L.bind(function () {
                L.Util.requestAnimFrame(function () {
                    this._redrawRequested = false;
                    this._redraw();
                }, this);
            }, this), wait);
        },

        // the loaded tile for t, or the nearest loaded coarser tile covering it (drawn clipped to t)
        _drawableTile: function (sourceId, source, t) {
            var entry = this._tiles[this._key(sourceId, t)];
            if (entry && entry.status === 'loaded') return { tile: t, entry: entry };

            var grid = source.grid, env = this._tileEnvelope(grid, t.level, t.row, t.col);
            var cx = (env.minX + env.maxX) / 2, cy = (env.minY + env.maxY) / 2;
            for (var level = t.level - 1; level >= source.minLevel; level--) {
                var res = grid.resolutions[level], w = grid.tileSize[0] * res, h = grid.tileSize[1] * res;
                var parent = { level: level, col: Math.floor((cx - grid.origin[0]) / w), row: Math.floor((grid.origin[1] - cy) / h) };
                var pe = this._tiles[this._key(sourceId, parent)];
                if (pe && pe.status === 'loaded') return { tile: parent, entry: pe };
            }
            return null;
        },

        // ---------------------------------------------------------------- drawing

        _redraw: function () {
            if (!this._ctx || !this._style || !this._validResolution()) return;
            if (this._outsideZoom()) return this._clearCanvases();
            this._lastRedraw = Date.now();

            // the canvases at the current view (not during a zoom animation: they are scaled by CSS then)
            var map = this._map;
            if (!map._animatingZoom) {
                this._center = map.getCenter();
                this._zoom = map.getZoom();
                this._canvasOrigin = this._layerOrigin();
                this._canvasGlobal = this._canvasOrigin.add(map.getPixelOrigin());
                L.DomUtil.setPosition(this._canvas, this._canvasOrigin);
                L.DomUtil.setPosition(this._labelCanvas, this._canvasOrigin);
            }

            var ctx = this._ctx, ratio = this._ratio(), size = this._canvasSize();
            var previous = this._keepFrame();
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.clearRect(0, 0, size.x, size.y);

            var resolution = this._mapResolution();
            var self = this, labels = [];
            var snap = function (v) { return Math.round(v * ratio) / ratio; };

            // per source: style zoom and the tiles to draw, with their placement on the canvas
            var perSource = {};
            Object.keys(this._sources).forEach(function (id) {
                var source = self._sources[id], grid = source.grid;
                var level = self._level(source, resolution);
                var drawables = [], missing = [];
                self._visibleTiles(grid, level).forEach(function (t) {
                    var d = self._drawableTile(id, source, t);
                    var clipEnv = self._tileEnvelope(grid, t.level, t.row, t.col);
                    if (!d) {
                        var m0 = self._toCanvas(clipEnv.minX, clipEnv.maxY), m1 = self._toCanvas(clipEnv.maxX, clipEnv.minY);
                        missing.push([m0.x, m0.y, m1.x - m0.x, m1.y - m0.y]);
                        return;
                    }
                    var env = self._tileEnvelope(grid, d.tile.level, d.tile.row, d.tile.col);
                    var p0 = self._toCanvas(env.minX, env.maxY), p1 = self._toCanvas(env.maxX, env.minY);
                    var c0 = self._toCanvas(clipEnv.minX, clipEnv.maxY), c1 = self._toCanvas(clipEnv.maxX, clipEnv.minY);
                    // tile borders on whole device pixels: neighbor tiles share the rounded border, no antialiased
                    // seam where the background shines through
                    var x0 = snap(c0.x), y0 = snap(c0.y), x1 = snap(c1.x), y1 = snap(c1.y);
                    drawables.push({ entry: d.entry, x0: p0.x, y0: p0.y, sx: p1.x - p0.x, sy: p1.y - p0.y, clip: [x0, y0, x1 - x0, y1 - y0], tile: d.tile, req: t });
                });
                perSource[id] = { zoom: self._styleZoom(source, resolution), drawables: drawables, missing: missing };
            });

            var firstSource = perSource[Object.keys(perSource)[0]];
            var defaultZoom = firstSource ? firstSource.zoom : 0;

            var usedImages = {};

            // background layers directly on the canvas
            this._style.layers.forEach(function (styleLayer) {
                var current = perSource[styleLayer.source];
                var zoom = current ? current.zoom : defaultZoom;
                if (!self._layerVisible(styleLayer, zoom)) return;

                if (styleLayer.type === 'background') {
                    ctx.globalAlpha = self._paint(styleLayer, 'background-opacity', null, zoom, 1);
                    ctx.fillStyle = self._paint(styleLayer, 'background-color', null, zoom, 'transparent');
                    ctx.fillRect(0, 0, size.x, size.y);
                    ctx.globalAlpha = 1;
                }
            });

            // geometry layers per run and tile from the tile image cache (rendered in the worker or in frame chunks)
            var now = Date.now(), fading = false;
            this._renderQueue = {};
            var ops = [], gaps = [];
            (this._runs || []).forEach(function (run) {
                var current = perSource[run.source];
                if (!current) return;   // a source that could not be loaded
                gaps = gaps.concat(current.missing);
                current.drawables.forEach(function (d) {
                    var image = self._tileImage(run.source, d, current.zoom, usedImages, run);
                    if (image === undefined) gaps.push(d.clip);
                    ops.push({ run: run, current: current, d: d, image: image });
                });
            });
            // tiles of a new zoom level not rendered yet: the last frame (scaled to this zoom) fills the gaps, so the
            // map doesn't disappear while zooming
            // only where tiles are missing: below finished tiles it would double semi-transparent fills
            var gapKeys = {};
            if (gaps.length && previous) {
                this._drawFrame(ctx, previous, gaps);
                gaps.forEach(function (g) { gapKeys[g.map(Math.round).join(',')] = true; });
            }

            ops.forEach(function (op) {
                var run = op.run, id = run.source, current = op.current, d = op.d, image = op.image;
                // several runs: a tile where one of them is missing shows the last frame only (until all are there)
                if (gapKeys[d.clip.map(Math.round).join(',')]) return;
                {
                    if (image && image.layerRect) {
                        // overzoomed part rendered in the worker: placed by its map pixels at the zoom it was rendered
                        // for, scaled to the current zoom (the image of a slightly different zoom, until the new one)
                        var origin = self._layerOrigin().add(self._map.getPixelOrigin());
                        var scale = self._map.getZoomScale(self._map.getZoom(), image.mapZoom), lr = image.layerRect;
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(d.clip[0], d.clip[1], d.clip[2], d.clip[3]);
                        ctx.clip();
                        ctx.drawImage(image.canvas, lr[0] * scale - origin.x, lr[1] * scale - origin.y, lr[2] * scale, lr[3] * scale);
                        ctx.restore();
                        return;
                    }
                    if (image) {
                        // the current image, or the one of the previous zoom step (scaled) while the new one renders;
                        // a tile appearing for the first time fades in
                        var alpha = self._tileAlpha(self._imageKey(id, d, run), now);
                        if (alpha < 1) { fading = true; ctx.globalAlpha = alpha; }
                        ctx.drawImage(image, d.clip[0], d.clip[1], d.clip[2], d.clip[3]);
                        ctx.globalAlpha = 1;
                        return;
                    }
                    if (image === undefined) return;   // queued, nothing to show yet

                    // overzoomed far beyond the last level: the tile would be a huge image, draw it directly
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(d.clip[0], d.clip[1], d.clip[2], d.clip[3]);
                    ctx.clip();
                    self._style.layers.forEach(function (styleLayer, layerIndex) {
                        if (layerIndex < run.from || layerIndex > run.to) return;
                        if (styleLayer.source !== id || styleLayer.type === 'background') return;
                        if (styleLayer.type === 'symbol' && !iconInTile(styleLayer)) return;
                        if (!self._layerVisible(styleLayer, current.zoom)) return;
                        self._drawLayerTile(ctx, styleLayer, layerIndex, d, current.zoom, null);
                    });
                    ctx.restore();
                }
            });
            // what this frame shows: kept for the next redraw (see _keepFrame)
            this._frameGlobal = this._layerOrigin().add(map.getPixelOrigin());
            this._frameZoom = map.getZoom();
            // tile images not drawn now are dropped
            Object.keys(this._images).forEach(function (key) { if (!usedImages[key] && !self._rendering[key]) self._dropImage(key); });
            this._scheduleRender();
            this._checkLoading();

            // labels: placed again on every redraw, except while panning (they move with the map, the labels of
            // newly visible parts are placed when the browser has time)
            this._perSource = perSource;
            if (fading) this._requestFadeFrame();

            if (this._moving || this._fadeRedraw || this._isPanning()) {
                this._paintLabels();   // moved with the map; placed again at the end of the gesture
            } else {
                this._placeLabels();
            }

            if (this.options.debug) {
                ctx.strokeStyle = 'rgba(255,0,0,.6)';
                ctx.fillStyle = 'rgba(255,0,0,.8)';
                ctx.font = '12px sans-serif';
                Object.keys(perSource).forEach(function (id) {
                    perSource[id].drawables.forEach(function (d) {
                        ctx.strokeRect(d.clip[0], d.clip[1], d.clip[2], d.clip[3]);
                        ctx.fillText(id + ' z' + d.tile.level + ' r' + d.tile.row + ' c' + d.tile.col, d.clip[0] + 4, d.clip[1] + 14);
                    });
                });
            }
        },

        // the geometry layers of a tile as image, rendered once per (tile, zoom step) and reused while panning.
        // Returns the image, null (too big: draw directly) or undefined (queued, nothing yet). A missing or
        // outdated image is queued for rendering; an outdated one is returned meanwhile (drawn scaled).
        _layerVisible: function (styleLayer, zoom) { return this._renderer._layerVisible(styleLayer, zoom); },
        _paint: function (styleLayer, name, feature, zoom, fallback) { return this._renderer._paint(styleLayer, name, feature, zoom, fallback); },
        _layout: function (styleLayer, name, feature, zoom, fallback) { return this._renderer._layout(styleLayer, name, feature, zoom, fallback); },
        _spriteEntry: function (name) { return this._renderer._spriteEntry(name); },

        // geometry on ctx, or (symbols) collected into labels
        _drawLayerTile: function (ctx, styleLayer, layerIndex, d, zoom, labels) {
            var self = this;
            this._renderer._drawLayerTile(ctx, styleLayer, layerIndex, d, zoom, labels ? function (feature, tx, ty) {
                self._collectSymbol(labels, styleLayer, feature, zoom, tx, ty, d, layerIndex);
            } : null);
        },

        _imageKey: function (sourceId, d, run) {
            return run.index + ':' + sourceId + '|' + d.req.level + '/' + d.req.row + '/' + d.req.col;
        },

        _tileImage: function (sourceId, d, zoom, usedImages, run) {
            // half zoom steps; the style version: images of an older style are rendered again
            var zoomKey = Math.round(zoom * 2) / 2 + '@' + this._styleVersion;
            var key = this._imageKey(sourceId, d, run);
            usedImages[key] = true;

            var ratio = this._ratio();
            var cached = this._images[key];

            if (d.clip[2] * ratio > 4096 || d.clip[3] * ratio > 4096) {
                // overzoomed far beyond the cache: the whole tile would be a huge image
                if (!this._worker) return null;   // main thread: drawn directly
                // worker: only the visible part of the tile, positioned in map pixels at the exact map zoom (stable
                // while panning; layer pixels change with the pixel origin at each zoom)
                var size = this._canvasSize(), origin = this._layerOrigin().add(this._map.getPixelOrigin()), mapZoom = this._map.getZoom();
                var vx = Math.max(0, d.clip[0]), vy = Math.max(0, d.clip[1]);
                var vw = Math.min(size.x, d.clip[0] + d.clip[2]) - vx, vh = Math.min(size.y, d.clip[1] + d.clip[3]) - vy;
                if (vw <= 0 || vh <= 0) return undefined;
                var rect = [vx + origin.x, vy + origin.y, vw, vh];
                var covers = cached && cached.layerRect && cached.zoomKey === zoomKey && cached.mapZoom === mapZoom && cached.entry === d.entry &&
                    cached.layerRect[0] <= rect[0] + 0.5 && cached.layerRect[1] <= rect[1] + 0.5 &&
                    cached.layerRect[0] + cached.layerRect[2] >= rect[0] + rect[2] - 0.5 && cached.layerRect[1] + cached.layerRect[3] >= rect[1] + rect[3] - 0.5;
                if (!covers) {
                    this._renderQueue[key] = { sourceId: sourceId, d: d, zoom: zoom, zoomKey: zoomKey, view: [vx, vy, vw, vh], layerRect: rect, mapZoom: mapZoom, from: run.from, to: run.to };
                }
                return cached && cached.layerRect ? cached : undefined;   // drawn at its layer rect
            }

            if (cached && !cached.layerRect && cached.zoomKey === zoomKey && cached.entry === d.entry) return cached.canvas;
            // during a gesture an existing image is drawn scaled and rendered again at its end: zooming in, the
            // images grow (up to 2048² px at a device pixel ratio of 2), rendering and uploading them every half zoom
            // step is expensive (Chrome uploads each new image to the GPU)
            if (cached && !cached.layerRect && this._moving && cached.entry === d.entry) return cached.canvas;

            this._renderQueue[key] = { sourceId: sourceId, d: d, zoom: zoom, zoomKey: zoomKey, from: run.from, to: run.to };
            return cached && !cached.layerRect ? cached.canvas : undefined;
        },

        // render jobs to the worker, nearest to the center first, a few at a time
        _sendRenderJobs: function () {
            var size = this._canvasSize(), cx = size.x / 2, cy = size.y / 2, queue = this._renderQueue, self = this;
            var ratio = this._ratio();
            var keys = Object.keys(queue).sort(function (a, b) {
                var da = queue[a].d.clip, db = queue[b].d.clip;
                return Math.hypot(da[0] + da[2] / 2 - cx, da[1] + da[3] / 2 - cy) - Math.hypot(db[0] + db[2] / 2 - cx, db[1] + db[3] / 2 - cy);
            });

            var running = Object.keys(this._rendering).length;
            keys.forEach(function (key) {
                var job = queue[key];
                if (self._rendering[key] === job.zoomKey) return;   // already rendering this
                if (running >= self.options.maxConcurrentRenders) return;

                var view = job.view || job.d.clip;
                var w = Math.max(1, Math.round(view[2] * ratio)), h = Math.max(1, Math.round(view[3] * ratio));
                self._rendering[key] = job.zoomKey;
                running++;
                self._worker.postMessage({
                    type: 'render', key: key, tileKey: self._key(job.sourceId, job.d.tile), sourceId: job.sourceId,
                    zoom: job.zoom, zoomKey: job.zoomKey, w: w, h: h, view: view, layerRect: job.layerRect || null, mapZoom: job.mapZoom,
                    from: job.from, to: job.to, gpu: !!self.options.gpuTileRendering,
                    d: { x0: job.d.x0, y0: job.d.y0, sx: job.d.sx, sy: job.d.sy, clip: job.d.clip }
                });
            });
        },

        _renderTileImage: function (key, job) {
            var d = job.d, ratio = this._ratio();
            var w = Math.max(1, Math.round(d.clip[2] * ratio)), h = Math.max(1, Math.round(d.clip[3] * ratio));

            var cached = this._images[key];
            var canvas = cached && cached.canvas.width === w && cached.canvas.height === h ? cached.canvas : document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            var c = canvas.getContext('2d', this.options.gpuTileRendering ? undefined : { willReadFrequently: true });
            c.clearRect(0, 0, w, h);
            // draw in the coordinates of the map canvas, shifted to the tile
            var sx = w / d.clip[2], sy = h / d.clip[3];
            c.setTransform(sx, 0, 0, sy, -d.clip[0] * sx, -d.clip[1] * sy);

            this._renderer.renderTile(c, job.sourceId, d, job.zoom, job.from, job.to);

            this._images[key] = { canvas: canvas, zoomKey: job.zoomKey, entry: d.entry };
        },

        // renders queued tile images, nearest to the center first, within the frame budget; the rest next frame
        _scheduleRender: function () {
            if (this._worker) {
                this._sendRenderJobs();
                return;
            }
            if (this._renderRequested || !Object.keys(this._renderQueue).length) return;
            this._renderRequested = true;
            L.Util.requestAnimFrame(function () {
                this._renderRequested = false;
                if (!this._map || !this._ctx) return;

                var size = this._canvasSize(), cx = size.x / 2, cy = size.y / 2, queue = this._renderQueue;
                var keys = Object.keys(queue).sort(function (a, b) {
                    var da = queue[a].d.clip, db = queue[b].d.clip;
                    return Math.hypot(da[0] + da[2] / 2 - cx, da[1] + da[3] / 2 - cy) - Math.hypot(db[0] + db[2] / 2 - cx, db[1] + db[3] / 2 - cy);
                });

                var start = performance.now();
                for (var i = 0; i < keys.length; i++) {
                    this._renderTileImage(keys[i], queue[keys[i]]);
                    delete queue[keys[i]];
                    if (performance.now() - start > this.options.renderBudget) break;
                }

                // shows the new images (cheap: images are cached) and queues what is still missing
                this._redraw();
            }, this);
        },

        // icon image (an SDF icon tinted with icon-color): { source, x, y, width, height }, the same object for the
        // same icon (it keeps the icon's own canvas, see _iconCanvas)
        _iconImage: function (entry, name, color) {
            if (!entry.sdf || !color) {
                return entry.icon || (entry.icon = { source: this._sprite.image, x: entry.x, y: entry.y, width: entry.width, height: entry.height });
            }

            var key = name + '|' + color;
            if (!this._tinted[key]) {
                var canvas = document.createElement('canvas');
                canvas.width = entry.width;
                canvas.height = entry.height;
                var c = canvas.getContext('2d');
                c.drawImage(this._sprite.image, entry.x, entry.y, entry.width, entry.height, 0, 0, entry.width, entry.height);
                // SDF: alpha above ~0.75 is inside the shape
                var data = c.getImageData(0, 0, entry.width, entry.height);
                for (var i = 3; i < data.data.length; i += 4) {
                    var a = data.data[i] / 255;
                    data.data[i] = Math.max(0, Math.min(255, Math.round((a - 0.7) / 0.1 * 255)));
                }
                c.putImageData(data, 0, 0);
                c.globalCompositeOperation = 'source-in';
                c.fillStyle = color;
                c.fillRect(0, 0, entry.width, entry.height);
                this._tinted[key] = { source: canvas, canvas: canvas, x: 0, y: 0, width: entry.width, height: entry.height };
            }
            return this._tinted[key];
        },

        // ---------------------------------------------------------------- symbols (icons, labels)

        _collectSymbol: function (labels, styleLayer, feature, zoom, tx, ty, drawable, layerIndex) {
            // overzoomed tiles hold many more symbols than the canvas shows: first where, then whether, then what
            var clip = drawable.clip, self = this, area = this._labelArea;
            if (feature.type === 'Point') {
                // points: any anchor on the canvas and in this tile? (cheap, before evaluating the style)
                var inside = feature.geometry.some(function (path) {
                    return path.some(function (p) {
                        var x = tx(p), y = ty(p);
                        return x >= clip[0] && y >= clip[1] && x < clip[0] + clip[2] && y < clip[1] + clip[3] &&
                            (!area || (x >= 0 && y >= 0 && x <= area.x && y <= area.y));
                    });
                });
                if (!inside) return;
            }

            // invisible at this zoom (text size or opacity 0, icon opacity 0): not placed at all
            var size = this._layout(styleLayer, 'text-size', feature, zoom, 16);
            var textVisible = size > 0 && this._paint(styleLayer, 'text-opacity', feature, zoom, 1) > 0;
            var iconVisible = this._paint(styleLayer, 'icon-opacity', feature, zoom, 1) > 0 && this._layout(styleLayer, 'icon-size', feature, zoom, 1) > 0;
            if (!textVisible && !iconVisible) return;

            var iconName = iconVisible ? resolveTokens(this._layout(styleLayer, 'icon-image', feature, zoom, null), feature) : null;
            var text = textVisible ? resolveTokens(this._layout(styleLayer, 'text-field', feature, zoom, null), feature) : null;
            if (text !== null && text !== undefined) {
                text = String(text);
                var transform = this._layout(styleLayer, 'text-transform', feature, zoom, 'none');
                if (transform === 'uppercase') text = text.toUpperCase();
                else if (transform === 'lowercase') text = text.toLowerCase();
            }
            if (!iconName && !text) return;

            var placement = this._layout(styleLayer, 'symbol-placement', feature, zoom, 'point');
            var keepViewport = placement === 'line-center' || this._layout(styleLayer, 'text-rotation-alignment', feature, zoom, 'map') === 'viewport';
            var spacing = placement === 'line' ? this._layout(styleLayer, 'symbol-spacing', feature, zoom, 250) : 0;
            var anchorPoints = symbolAnchors(feature, placement, spacing, keepViewport, tx, ty);
            var shift = this._renderer._layerTranslate(styleLayer, zoom);
            if (shift[0] || shift[1]) {
                anchorPoints.forEach(function (a) {
                    a.x += shift[0]; a.y += shift[1];
                    if (a.path) a.path = a.path.map(function (pt) { return [pt[0] + shift[0], pt[1] + shift[1]]; });
                });
            }
            var iconEntry = iconName ? this._spriteEntry(iconName) : null;
            var iconColor = this._paint(styleLayer, 'icon-color', feature, zoom, null);

            anchorPoints.forEach(function (a) {
                // only symbols anchored inside this tile: the neighbor tile draws its own
                if (a.x < clip[0] || a.y < clip[1] || a.x >= clip[0] + clip[2] || a.y >= clip[1] + clip[3]) return;
                if (area && (a.x < 0 || a.y < 0 || a.x > area.x || a.y > area.y)) return;

                var variable = self._layout(styleLayer, 'text-variable-anchor', feature, zoom, null);
                labels.push({
                    id: styleLayer.id + '|' + (iconName || '') + '|' + (text || ''),
                    // the same label in another style layer (styles often have one layer per zoom range)
                    fadeId: (iconName || '') + '|' + (text || ''),
                    x: a.x, y: a.y, angle: a.angle,
                    icon: iconEntry ? self._iconImage(iconEntry, iconName, iconColor) : null,
                    iconRatio: iconEntry ? (iconEntry.pixelRatio || self._sprite.pixelRatio) : 1,
                    iconSize: self._layout(styleLayer, 'icon-size', feature, zoom, 1),
                    iconRotate: self._layout(styleLayer, 'icon-rotate', feature, zoom, 0) * Math.PI / 180,
                    iconOpacity: self._paint(styleLayer, 'icon-opacity', feature, zoom, 1),
                    // placement priority: higher style layers first (as GL), within a layer by symbol-sort-key
                    layerIndex: layerIndex,
                    sortKey: self._layout(styleLayer, 'symbol-sort-key', feature, zoom, 0),
                    iconOverlap: self._layout(styleLayer, 'icon-allow-overlap', feature, zoom, false),
                    iconOptional: self._layout(styleLayer, 'icon-optional', feature, zoom, false),
                    iconIgnorePlacement: self._layout(styleLayer, 'icon-ignore-placement', feature, zoom, false),
                    textOptional: self._layout(styleLayer, 'text-optional', feature, zoom, false),
                    textIgnorePlacement: self._layout(styleLayer, 'text-ignore-placement', feature, zoom, false),
                    text: text || null,
                    font: cssFont(self._layout(styleLayer, 'text-font', feature, zoom, ['Arial Regular']), size),
                    size: size,
                    letterSpacing: self._layout(styleLayer, 'text-letter-spacing', feature, zoom, 0),
                    maxWidth: self._layout(styleLayer, 'text-max-width', feature, zoom, 10),
                    anchor: self._layout(styleLayer, 'text-anchor', feature, zoom, 'center'),
                    offset: self._layout(styleLayer, 'text-offset', feature, zoom, [0, 0]),
                    // text-variable-anchor: the first of these anchors where the label fits (text-radial-offset)
                    anchors: Array.isArray(variable) && variable.length ? variable : null,
                    radialOffset: self._layout(styleLayer, 'text-radial-offset', feature, zoom, null),
                    justify: self._layout(styleLayer, 'text-justify', feature, zoom, 'center'),
                    lineHeight: self._layout(styleLayer, 'text-line-height', feature, zoom, 1.2),
                    // icon-text-fit: the icon stretched around the text (road shields)
                    iconTextFit: self._layout(styleLayer, 'icon-text-fit', feature, zoom, 'none'),
                    iconTextFitPadding: self._layout(styleLayer, 'icon-text-fit-padding', feature, zoom, [0, 0, 0, 0]),
                    textRotate: self._layout(styleLayer, 'text-rotate', feature, zoom, 0) * Math.PI / 180,
                    textOverlap: self._layout(styleLayer, 'text-allow-overlap', feature, zoom, false),
                    padding: self._layout(styleLayer, 'text-padding', feature, zoom, 2),
                    color: self._paint(styleLayer, 'text-color', feature, zoom, '#000'),
                    opacity: self._paint(styleLayer, 'text-opacity', feature, zoom, 1),
                    haloColor: self._paint(styleLayer, 'text-halo-color', feature, zoom, null),
                    haloWidth: self._paint(styleLayer, 'text-halo-width', feature, zoom, 0),
                    alongLine: a.lineLength !== undefined && placement !== 'point',
                    lineLength: a.lineLength,
                    // 'line' placement, aligned to the map: the text follows the line glyph by glyph
                    curvedPath: placement === 'line' && !keepViewport && a.path ? a.path : null,
                    curvedDistance: a.distance,
                    maxAngle: self._layout(styleLayer, 'text-max-angle', feature, zoom, 45) * Math.PI / 180
                });
            });
        },

        // ---------------------------------------------------------------- labels

        // collision handling: which labels (icon, text or both) are shown, and their layout in canvas pixels.
        // Labels shown at the last redraw (same zoom) are placed first, so they don't jump while panning.
        _placeSymbols: function (labels) {
            var declutter = this.options.declutter, ctx = this._labelCtx;

            // placed boxes in a grid of 64 px cells: a box is only tested against the boxes of its cells
            var CELL = 64, grid = {};
            function cells(box, fn) {
                for (var gx = Math.floor(box[0] / CELL), gx1 = Math.floor(box[2] / CELL); gx <= gx1; gx++) {
                    for (var gy = Math.floor(box[1] / CELL), gy1 = Math.floor(box[3] / CELL); gy <= gy1; gy++) {
                        if (fn(gx + ',' + gy) === true) return true;
                    }
                }
                return false;
            }
            function collides(box) {
                if (!box) return false;
                return cells(box, function (cell) {
                    var list = grid[cell];
                    if (!list) return false;
                    for (var i = 0; i < list.length; i++) {
                        var p = list[i];
                        if (box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]) return true;
                    }
                    return false;
                });
            }
            function push(box) { cells(box, function (cell) { (grid[cell] || (grid[cell] = [])).push(box); }); }

            function setLetterSpacing(px) {
                if ('letterSpacing' in ctx) ctx.letterSpacing = px ? px + 'px' : '0px';
            }

            function rotatedBox(l, dx, dy, width, height, angle, pad) {
                var cos = Math.cos(angle), sin = Math.sin(angle);
                var corners = [[dx, dy], [dx + width, dy], [dx, dy + height], [dx + width, dy + height]].map(function (c) {
                    return [l.x + c[0] * cos - c[1] * sin, l.y + c[0] * sin + c[1] * cos];
                });
                return [
                    Math.min.apply(null, corners.map(function (c) { return c[0]; })) - pad,
                    Math.min.apply(null, corners.map(function (c) { return c[1]; })) - pad,
                    Math.max.apply(null, corners.map(function (c) { return c[0]; })) + pad,
                    Math.max.apply(null, corners.map(function (c) { return c[1]; })) + pad
                ];
            }

            var measure = L.bind(this._measure, this);

            // position keys in layer pixels: the same feature has the same key while the map is only panned
            var origin = this._canvasOrigin || this._layerOrigin(), zoom = this._zoom;
            if (zoom !== this._shownZoom) { this._shown = {}; this._shownZoom = zoom; }
            var previous = this._shown, shown = {}, now = Date.now();
            var refade = !!this._labelsFaded;   // faded out while zooming out: all fade in again
            this._labelsFaded = false;
            // labels seen in the last seconds (by text and icon): no fading in after a zoom step, also when an
            // intermediate placement (tiles still loading) showed only a few of them
            var seenIds = this._shownIds;
            this._placed.forEach(function (p) { seenIds[p.l.fadeId] = now; });   // visible until now
            labels.forEach(function (l) {
                l.key = l.id + '@' + Math.round(l.x + origin.x) + ',' + Math.round(l.y + origin.y);
            });
            // placement order: labels shown before (stable while panning), then as GL: the higher style layer first,
            // within a layer the lower symbol-sort-key first, else the order of the features
            var order = new Map();
            labels.forEach(function (l, i) { order.set(l, i); });
            var ordered = labels.slice().sort(function (a, b) {
                return (previous[b.key] ? 1 : 0) - (previous[a.key] ? 1 : 0) ||
                    (b.layerIndex || 0) - (a.layerIndex || 0) ||
                    (Number(a.sortKey) || 0) - (Number(b.sortKey) || 0) ||
                    order.get(a) - order.get(b);
            });

            var placed = [];
            ordered.forEach(function (l) {
                // ---- icon layout
                var icon = null;
                if (l.icon) {
                    var w = l.icon.width / l.iconRatio * l.iconSize, h = l.icon.height / l.iconRatio * l.iconSize;
                    icon = { w: w, h: h, box: [l.x - w / 2, l.y - h / 2, l.x + w / 2, l.y + h / 2] };
                }

                // ---- text layout
                var text = null;
                if (l.text) {
                    ctx.font = l.font;
                    setLetterSpacing(l.letterSpacing * l.size);

                    // point labels wrap at text-max-width (ems), as GL does
                    var lines = [l.text];
                    if (!l.alongLine && l.maxWidth > 0) {
                        var maxPx = l.maxWidth * l.size, words = l.text.split(' '), current = '';
                        lines = [];
                        words.forEach(function (word) {
                            var candidate = current ? current + ' ' + word : word;
                            if (current && measure(candidate) > maxPx) { lines.push(current); current = word; }
                            else current = candidate;
                        });
                        if (current) lines.push(current);
                    }

                    var lineHeight = l.size * (l.lineHeight || 1.2);
                    var width = Math.max.apply(null, lines.map(function (line) { return measure(line); }));
                    var height = lineHeight * lines.length;
                    setLetterSpacing(0);

                    if (l.curvedPath) {
                        // along the line, glyph by glyph. The text is centered on its anchor: if already the box of
                        // one glyph at the anchor collides, the whole text does (most anchors of dense line labels)
                        var half0 = l.size / 2;
                        var hidden = declutter && !l.textOverlap && !l.icon && collides([l.x - half0, l.y - half0, l.x + half0, l.y + half0]);
                        var glyphs = hidden ? null : placeAlongPath(measure, l.text, l.curvedPath, l.curvedDistance, l.maxAngle, l.letterSpacing * l.size);
                        if (glyphs) {
                            var half = l.size / 2 + l.padding;
                            text = {
                                glyphs: glyphs,
                                box: [
                                    Math.min.apply(null, glyphs.map(function (g) { return g.x; })) - half,
                                    Math.min.apply(null, glyphs.map(function (g) { return g.y; })) - half,
                                    Math.max.apply(null, glyphs.map(function (g) { return g.x; })) + half,
                                    Math.max.apply(null, glyphs.map(function (g) { return g.y; })) + half
                                ]
                            };
                        }
                    } else if (!(l.alongLine && width > l.lineLength)) {
                        // longer than its line: no text there, as GL. Variable anchors: the first one that fits.
                        var candidates = l.anchors && !l.alongLine ? l.anchors : [l.anchor];
                        var angle = l.angle + l.textRotate;
                        for (var ci = 0; ci < candidates.length; ci++) {
                            var name = candidates[ci], anchor = ANCHORS[name] || ANCHORS.center;
                            var off = l.anchors && !l.alongLine ? anchorOffset(name, l.radialOffset, l.offset) : l.offset;
                            var dx = anchor[0] * width + (off[0] || 0) * l.size;
                            var dy = anchor[1] * height + (off[1] || 0) * l.size;
                            var candidate = {
                                lines: lines, lineHeight: lineHeight, width: width, height: height, dx: dx, dy: dy, angle: angle,
                                justify: justification(l.justify, name),
                                box: rotatedBox(l, dx, dy, width, height, angle, l.padding)
                            };
                            if (!text) text = candidate;   // none fits: the first
                            if (!declutter || l.textOverlap || !collides(candidate.box)) { text = candidate; break; }
                        }
                    }
                }
                if (!icon && !text) return;
                // the text could not be laid out (longer than its line, too curved): without it no icon either, unless
                // the text is optional (as GL; otherwise empty road shields)
                if (l.text && !text && !l.textOptional) return;

                // ---- icon-text-fit: the icon stretched around the text (padding: top, right, bottom, left)
                if (icon && text && !text.glyphs && l.iconTextFit && l.iconTextFit !== 'none') {
                    var pad = l.iconTextFitPadding || [0, 0, 0, 0];
                    var fitW = l.iconTextFit !== 'height', fitH = l.iconTextFit !== 'width';
                    if (fitW) icon.w = text.width + pad[1] + pad[3];
                    if (fitH) icon.h = text.height + pad[0] + pad[2];
                    icon.cx = fitW ? text.dx - pad[3] + icon.w / 2 : 0;
                    icon.cy = fitH ? text.dy - pad[0] + icon.h / 2 : 0;
                    icon.box = [l.x + icon.cx - icon.w / 2, l.y + icon.cy - icon.h / 2, l.x + icon.cx + icon.w / 2, l.y + icon.cy + icon.h / 2];
                }

                // ---- placement: icon and text of a symbol are placed together, as GL does
                var iconFits = !icon || !declutter || l.iconOverlap || !collides(icon.box);
                var textFits = !text || !declutter || l.textOverlap || !collides(text.box);

                var showIcon = !!icon, showText = !!text;
                if (!iconFits || !textFits) {
                    if (icon && text && iconFits && l.textOptional) showText = false;        // icon alone
                    else if (icon && text && textFits && l.iconOptional) showIcon = false;   // text alone
                    else return;
                }
                if (showIcon && !l.iconIgnorePlacement) push(icon.box);
                if (showText && !l.textIgnorePlacement) push(text.box);
                // shown since: new labels fade in (not those shown before the last zoom step)
                var since = shown[l.key] = refade ? now : previous[l.key] || (seenIds[l.fadeId] !== undefined ? 1 : now);
                seenIds[l.fadeId] = now;
                placed.push({ l: l, icon: showIcon ? icon : null, text: showText ? text : null, since: since });
            });

            // painted in style order (the placement order only decides who wins a collision)
            var rank = new Map();
            labels.forEach(function (l, i) { rank.set(l, i); });
            placed.sort(function (a, b) { return rank.get(a.l) - rank.get(b.l); });

            this._placed = placed;
            Object.keys(seenIds).forEach(function (id) { if (now - seenIds[id] > 10000) delete seenIds[id]; });
            this._placedOrigin = this._canvasOrigin;
            this._placedGlobal = this._canvasGlobal;
            this._placedZoom = this._zoom;
            this._lastPlacement = Date.now();
            this._shown = shown;
            // images of labels along lines: kept for the labels still shown at the same place (zoom: new keys)
            var curved = this._curvedCache || {}, keep = {};
            Object.keys(shown).forEach(function (key) { if (curved[key]) keep[key] = curved[key]; });
            this._curvedCache = keep;
        },

        // symbols (icons, labels) of all drawn tiles, placed with collision handling; only those anchored on the
        // canvas (tiles reach far beyond it)
        _placeLabels: function () {
            var perSource = this._perSource, labels = [], self = this;
            if (!perSource) return;
            this._labelArea = this._canvasSize();
            this._style.layers.forEach(function (styleLayer, layerIndex) {
                if (styleLayer.type !== 'symbol' || iconInTile(styleLayer)) return;
                var current = perSource[styleLayer.source];
                if (!current || !self._layerVisible(styleLayer, current.zoom)) return;
                current.drawables.forEach(function (d) {
                    self._drawLayerTile(self._ctx, styleLayer, layerIndex, d, current.zoom, labels);
                });
            });
            this._placeSymbols(labels);
            this._paintLabels();
        },

        _measure: function (text) {
            var ctx = this._labelCtx;
            var key = ctx.font + '|' + (ctx.letterSpacing || '') + '|' + text;
            var w = this._textWidths[key];
            if (w === undefined) {
                if (this._textWidthCount > 20000) { this._textWidths = {}; this._textWidthCount = 0; }
                w = this._textWidths[key] = ctx.measureText(text).width;
                this._textWidthCount++;
            }
            return w;
        },

        // a label image (text with halo, or one glyph's halo or fill), drawn once and reused on every frame
        _labelImage: function (key, w, h, pad, draw) {
            var sprite = this._sprites[key];
            if (sprite) return sprite;
            if (this._spriteCount > 3000) { this._sprites = {}; this._spriteCount = 0; }
            var ratio = this._ratio();
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.ceil((w + 2 * pad) * ratio));
            canvas.height = Math.max(1, Math.ceil((h + 2 * pad) * ratio));
            var ctx = canvas.getContext('2d');
            ctx.scale(ratio, ratio);
            draw(ctx);
            this._spriteCount++;
            return (this._sprites[key] = { canvas: canvas, w: canvas.width / ratio, h: canvas.height / ratio, pad: pad });
        },

        // an icon cut out of the sprite sheet once: drawing a part of a big image is slow, per frame and icon
        _iconCanvas: function (icon) {
            if (icon.canvas) return icon.canvas;
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, icon.width);
            canvas.height = Math.max(1, icon.height);
            canvas.getContext('2d').drawImage(icon.source, icon.x, icon.y, icon.width, icon.height, 0, 0, icon.width, icon.height);
            return (icon.canvas = canvas);
        },

        _textSprite: function (l, text) {
            var halo = l.haloColor && l.haloWidth > 0, pad = (halo ? l.haloWidth : 0) + Math.ceil(l.size * 0.25);
            var justify = text.justify || 'center';
            var key = 't|' + l.font + '|' + l.letterSpacing + '|' + l.color + '|' + (halo ? l.haloColor + '|' + l.haloWidth : '') + '|' + justify + '|' + text.lineHeight + '|' + text.lines.join('\n');
            return this._labelImage(key, text.width, text.height, pad, function (ctx) {
                ctx.font = l.font;
                if ('letterSpacing' in ctx) ctx.letterSpacing = l.letterSpacing ? l.letterSpacing * l.size + 'px' : '0px';
                ctx.textBaseline = 'top';
                ctx.textAlign = justify;
                ctx.lineJoin = 'round';
                text.lines.forEach(function (line, i) {
                    var lx = justify === 'left' ? pad : justify === 'right' ? pad + text.width : pad + text.width / 2;
                    var ly = pad + i * text.lineHeight + (text.lineHeight - l.size) / 2;
                    if (halo) {
                        ctx.lineWidth = l.haloWidth * 2;
                        ctx.strokeStyle = l.haloColor;
                        ctx.strokeText(line, lx, ly);
                    }
                    ctx.fillStyle = l.color;
                    ctx.fillText(line, lx, ly);
                });
            });
        },

        // a label along a line as one image, relative to its anchor: first all halos, then all glyphs (halos must
        // not cover neighbor glyphs)
        _curvedSprite: function (l, glyphs) {
            var ratio = this._ratio(), self = this;
            var reach = l.size * 1.2 + (l.haloWidth || 0) + 2;   // a glyph around its center, rotated
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            glyphs.forEach(function (g) {
                minX = Math.min(minX, g.x - l.x - reach); maxX = Math.max(maxX, g.x - l.x + reach);
                minY = Math.min(minY, g.y - l.y - reach); maxY = Math.max(maxY, g.y - l.y + reach);
            });
            var w = Math.max(1, Math.ceil((maxX - minX) * ratio)), h = Math.max(1, Math.ceil((maxY - minY) * ratio));
            var canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            var c = canvas.getContext('2d');
            for (var pass = 0; pass < 2; pass++) {
                var halo = pass === 0;
                if (halo && !(l.haloColor && l.haloWidth > 0)) continue;
                glyphs.forEach(function (g) {
                    var gs = self._glyphSprite(l, g.ch, halo);
                    var cos = Math.cos(g.angle) * ratio, sin = Math.sin(g.angle) * ratio;
                    c.setTransform(cos, sin, -sin, cos, (g.x - l.x - minX) * ratio, (g.y - l.y - minY) * ratio);
                    c.drawImage(gs.canvas, -gs.w / 2, -gs.h / 2, gs.w, gs.h);
                });
            }
            return { canvas: canvas, x: minX, y: minY, w: w / ratio, h: h / ratio };
        },

        _glyphSprite: function (l, ch, halo) {
            var pad = (halo ? l.haloWidth : 0) + Math.ceil(l.size * 0.25);
            var key = (halo ? 'h|' + l.haloColor + '|' + l.haloWidth : 'g|' + l.color) + '|' + l.font + '|' + ch;
            var ctx = this._labelCtx;
            ctx.font = l.font;
            var w = this._measure(ch), h = l.size * 1.4;
            return this._labelImage(key, w, h, pad, function (c) {
                c.font = l.font;
                c.textBaseline = 'middle';
                c.textAlign = 'center';
                if (halo) {
                    c.lineJoin = 'round';
                    c.lineWidth = l.haloWidth * 2;
                    c.strokeStyle = l.haloColor;
                    c.strokeText(ch, pad + w / 2, pad + h / 2);
                } else {
                    c.fillStyle = l.color;
                    c.fillText(ch, pad + w / 2, pad + h / 2);
                }
            });
        },

        // the placed labels on the label canvas, at the current (possibly animated) transform of the tile canvas:
        // the anchors move with the map, the labels keep their size
        _paintLabels: function () {
            var ctx = this._labelCtx;
            if (!ctx || !this._map) return;
            var ratio = this._ratio(), size = this._canvasSize();
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.clearRect(0, 0, size.x, size.y);
            if (!this._placed.length) return;

            var m = this._canvasTransform(), own = L.DomUtil.getPosition(this._labelCanvas) || L.point(0, 0);
            // labels placed at an earlier canvas position or zoom: their anchors in map pixels, scaled to the zoom the
            // canvas shows
            var k = 1, shiftX = 0, shiftY = 0;
            if (this._placedGlobal && this._canvasGlobal) {
                k = this._map.getZoomScale(this._zoom, this._placedZoom);
                shiftX = this._placedGlobal.x * k - this._canvasGlobal.x;
                shiftY = this._placedGlobal.y * k - this._canvasGlobal.y;
            }
            var self = this, maxX = size.x + 256, maxY = size.y + 256;

            // zoomed out since the placement (during a gesture): the labels would pile up at the same size; they shrink
            // with the map and fade out, gone one zoom level out (placed again at the end of the gesture)
            var since = k * m.a, shrink = since < 1 ? since : 1;
            var vanish = since < 1 ? Math.max(0, 1 + Math.log(since) / Math.LN2) : 1;
            this._labelsFaded = vanish < 1;   // the next placement fades the labels in again
            if (vanish <= 0) { ctx.setTransform(ratio, 0, 0, ratio, 0, 0); return; }

            // one transform per image (rotation about the anchor, device pixel ratio, shrinking): no save/restore per label
            var unit = ratio * shrink;
            function place(x, y, angle) {
                if (!angle) { ctx.setTransform(unit, 0, 0, unit, ratio * x, ratio * y); return; }
                var cos = Math.cos(angle) * unit, sin = Math.sin(angle) * unit;
                ctx.setTransform(cos, sin, -sin, cos, ratio * x, ratio * y);
            }

            var placed = this._placed, now = Date.now(), fade = this.options.fadeDuration > 0 ? this.options.fadeDuration : 0, fading = false;
            for (var i = 0; i < placed.length; i++) {
                var p = placed[i], l = p.l;
                var x = m.e + m.a * (l.x * k + shiftX) - own.x, y = m.f + m.a * (l.y * k + shiftY) - own.y;
                if (x < -256 || y < -256 || x > maxX || y > maxY) continue;

                // new labels fade in
                var alpha = fade ? Math.min(1, (now - p.since) / fade) : 1;
                if (alpha < 1) fading = true;
                alpha *= vanish;

                if (p.icon) {
                    ctx.globalAlpha = alpha * (l.iconOpacity === undefined ? 1 : l.iconOpacity);
                    place(x, y, l.angle + l.iconRotate);
                    ctx.drawImage(self._iconCanvas(l.icon), (p.icon.cx || 0) - p.icon.w / 2, (p.icon.cy || 0) - p.icon.h / 2, p.icon.w, p.icon.h);
                    ctx.globalAlpha = 1;
                }
                if (!p.text) continue;

                ctx.globalAlpha = l.opacity * alpha;
                if (p.text.glyphs) {
                    // text along a line: drawn once into its own image (glyph by glyph), then one image per frame
                    var cs = p.curvedSprite || (p.curvedSprite = self._curvedCache[l.key] || (self._curvedCache[l.key] = self._curvedSprite(l, p.text.glyphs)));
                    place(x, y, 0);
                    ctx.drawImage(cs.canvas, cs.x, cs.y, cs.w, cs.h);
                } else {
                    var s = self._textSprite(l, p.text);
                    place(x, y, p.text.angle);
                    ctx.drawImage(s.canvas, p.text.dx - s.pad, p.text.dy - s.pad, s.w, s.h);
                }
                ctx.globalAlpha = 1;
            }
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

            // labels fading in: the next frame (only painting, cheap)
            if (fading && !this._labelFadeFrame) {
                this._labelFadeFrame = L.Util.requestAnimFrame(function () {
                    this._labelFadeFrame = null;
                    if (this._labelCtx) this._paintLabels();
                }, this);
            }
        }
    });

    /**
     * Smooth wheel zoom: the map zooms continuously towards the zoom the wheel asks for, around the mouse position,
     * instead of in animated steps. Map options: `smoothWheelZoom: true` (replaces scrollWheelZoom),
     * `smoothWheelSpeed` (default 1: about half a zoom level per wheel notch).
     */
    var SmoothWheelZoom = L.Handler.extend({
        addHooks: function () {
            if (this._map.scrollWheelZoom) this._map.scrollWheelZoom.disable();
            L.DomEvent.on(this._map._container, 'wheel', this._onWheel, this);
        },

        removeHooks: function () {
            L.DomEvent.off(this._map._container, 'wheel', this._onWheel, this);
            if (this._frame) L.Util.cancelAnimFrame(this._frame);
            this._frame = null;
            if (this._active) this._end();
        },

        _onWheel: function (e) {
            L.DomEvent.stop(e);
            var map = this._map;
            if (!this._active) {
                map._stop();
                this._active = true;
                this._zoom = this._goal = map.getZoom();
                map.fire('movestart').fire('zoomstart');
            }
            var speed = map.options.smoothWheelSpeed || 1;
            this._goal = map._limitZoom(this._goal + L.DomEvent.getWheelDelta(e) / 100 * speed);
            // the point under the mouse stays where it is
            this._point = map.mouseEventToContainerPoint(e);
            this._anchor = map.containerPointToLatLng(this._point);
            if (!this._frame) this._frame = L.Util.requestAnimFrame(this._step, this);
        },

        _step: function () {
            this._frame = null;
            var map = this._map;
            if (!map || !this._active) return;

            var diff = this._goal - this._zoom;
            this._zoom = Math.abs(diff) < 0.002 ? this._goal : this._zoom + diff * 0.2;

            var half = map.getSize().divideBy(2);
            var center = map.unproject(map.project(this._anchor, this._zoom).subtract(this._point.subtract(half)), this._zoom);
            map._move(center, this._zoom);

            if (this._zoom === this._goal) this._end();
            else this._frame = L.Util.requestAnimFrame(this._step, this);
        },

        _end: function () {
            this._active = false;
            this._map._moveEnd(true);
        }
    });
    L.Map.mergeOptions({ smoothWheelZoom: false, smoothWheelSpeed: 1 });
    L.Map.addInitHook('addHandler', 'smoothWheelZoom', SmoothWheelZoom);
    GLVectorTiles.SmoothWheelZoom = SmoothWheelZoom;

    /**
     * A Proj4Leaflet CRS for the grid of a gView vector tile cache: the map's zoom levels are then exactly the
     * cache levels, plus `overzoomLevels` (default 3) levels with halved resolutions beyond the last cache level
     * (drawn with the last level's tiles). Set the map's maxZoom to `crs.options.resolutions.length - 1`.
     * Needs Proj4Leaflet (L.Proj.CRS) and the proj4 definition of the EPSG code.
     *   L.glVectorTiles.createCrs(style.metadata['gview:grid'], '+proj=tmerc ...', { overzoomLevels: 3 })
     */
    GLVectorTiles.createCrs = function (grid, proj4Definition, options) {
        if (!L.Proj || !L.Proj.CRS) throw new Error('Proj4Leaflet is required for L.glVectorTiles.createCrs');

        var overzoom = options && options.overzoomLevels !== undefined ? options.overzoomLevels : 3;
        var resolutions = grid.resolutions.slice();
        for (var i = 0; i < overzoom; i++) {
            resolutions.push(resolutions[resolutions.length - 1] / 2);
        }

        return new L.Proj.CRS('EPSG:' + grid.epsg, proj4Definition, {
            origin: grid.origin,
            resolutions: resolutions,
            bounds: grid.extent ? L.bounds([grid.extent[0], grid.extent[1]], [grid.extent[2], grid.extent[3]]) : undefined
        });
    };

    // ------------------------------------------------------------------------------------------
    // Images of an extent (printing): rendered with a hidden map of the image's size and pixel ratio, the same way
    // as on screen (tiles, labels placed for that size, color scheme, highlighting)
    // ------------------------------------------------------------------------------------------

    var CSS_PX_PER_METER = 96 / 0.0254;
    var MAX_IMAGE_SIDE = 16384;

    // projection units per CSS pixel of the map at its current zoom
    function mapResolution(map) {
        var crs = map.options.crs;
        var factor = crs.transformation && crs.transformation._a ? Math.abs(crs.transformation._a) : 1;
        return 1 / (crs.scale(map.getZoom()) * factor);
    }

    /**
     * The image size, pixel ratio and extent for options { extent, imageSize, dpi, scale } (see toImage):
     * extent [minX, minY, maxX, maxY] in projection units; resolution: projection units per CSS pixel of the map when
     * no scale is given. The extent is widened (centered) to the image's aspect ratio, never distorted.
     */
    function imageLayout(extent, options, resolution) {
        var minX = extent[0], minY = extent[1], maxX = extent[2], maxY = extent[3];
        var w = maxX - minX, h = maxY - minY;
        if (!(w > 0 && h > 0)) throw new Error('toImage: empty extent');
        var size = options.imageSize, dpi = options.dpi, res;

        if (size) {
            // the extent to the image's aspect ratio
            var aspect = size[0] / size[1], cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
            if (w / h < aspect) w = h * aspect; else h = w / aspect;
            minX = cx - w / 2; maxX = cx + w / 2; minY = cy - h / 2; maxY = cy + h / 2;
        }

        var ratio;
        if (size && dpi) {
            // image size and dpi: the scale follows
            ratio = dpi / 96;
            res = w / (size[0] / ratio);
        } else {
            res = options.scale ? options.scale / CSS_PX_PER_METER : resolution;
            if (!(res > 0)) throw new Error('toImage: no scale (and no map to take it from)');
            var cssW = w / res, cssH = h / res;
            if (size) {
                ratio = size[0] / cssW;   // image size: the dpi follows
            } else {
                ratio = (dpi || 96) / 96;   // dpi: the image size follows
                size = [Math.round(cssW * ratio), Math.round(cssH * ratio)];
            }
        }
        if (size[0] > MAX_IMAGE_SIDE || size[1] > MAX_IMAGE_SIDE) {
            throw new Error('toImage: ' + size[0] + ' x ' + size[1] + ' px is too large (max ' + MAX_IMAGE_SIDE + ' px per side)');
        }
        // the hidden map in CSS pixels (whole pixels), its pixel ratio giving the image size
        var css = [Math.max(1, Math.round(size[0] / ratio)), Math.max(1, Math.round(size[1] / ratio))];
        return {
            extent: [minX, minY, maxX, maxY], imageSize: [size[0], size[1]], cssSize: css, pixelRatio: size[0] / css[0],
            resolution: w / css[0], dpi: 96 * size[0] / css[0], scale: (w / css[0]) * CSS_PX_PER_METER
        };
    }

    function toExtent(map, extent) {
        var crs = map.options.crs;
        if (!extent) extent = map.getBounds();
        if (extent instanceof L.LatLngBounds || (Array.isArray(extent) && extent.length === 2)) {
            var b = L.latLngBounds(extent), sw = crs.project(b.getSouthWest()), ne = crs.project(b.getNorthEast());
            return [Math.min(sw.x, ne.x), Math.min(sw.y, ne.y), Math.max(sw.x, ne.x), Math.max(sw.y, ne.y)];
        }
        return extent.slice(0, 4);
    }

    // a copy of a layer for the hidden map: its current style (with runtime changes), color scheme, highlighting
    function printCopy(layer, pixelRatio) {
        var options = L.extend({}, layer.options, {
            style: JSON.parse(JSON.stringify(layer._style)), styleBase: layer._styleUrl, pixelRatio: pixelRatio,
            padding: 0, fadeDuration: 0, preload: 0, liveRedrawInterval: 0, lowPower: false, debug: false
        });
        var copy = new GLVectorTiles('', options);
        if (layer._highlight) {
            copy.once('styleload', function () { copy.highlight(layer._highlight.match, { dim: layer._highlight.dim }); });
        }
        return copy;
    }

    // resolves when the layer has loaded and drawn its tiles (or after the timeout: drawn as far as it got)
    function whenDrawn(layer, timeout) {
        return new Promise(function (resolve) {
            var done = false, timer = null, loaded = false;
            var finish = function (complete) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                clearTimeout(limit);
                resolve(complete);
            };
            var settle = function () {
                clearTimeout(timer);
                timer = setTimeout(function () { if (loaded && !layer._loading) finish(true); }, 300);
            };
            layer.on('load', function () { loaded = true; settle(); });
            layer.on('loading', function () { clearTimeout(timer); });
            layer.on('error', function () { settle(); });
            var limit = setTimeout(function () { finish(false); }, timeout);
        });
    }

    /**
     * Renders the GL layers of a map (or the given layers) for an extent into an image.
     *   options: extent (LatLngBounds or [minX, minY, maxX, maxY] in projection units; default the map's view),
     *            imageSize [w, h] and/or dpi, scale (1:scale; default the map's), background (CSS color),
     *            timeout (ms, default 60000)
     *   → Promise { canvas, extent (widened to the image's aspect ratio), imageSize, dpi, scale, attribution,
     *               complete (false: not all tiles loaded within the timeout) }
     */
    GLVectorTiles.mapToImage = function (map, options, layers) {
        options = options || {};
        if (!layers) {
            layers = [];
            map.eachLayer(function (l) { if (l instanceof GLVectorTiles && l._style) layers.push(l); });
            // in the order of the pane (drawn on top of each other)
            layers.sort(function (a, b) {
                var nodes = Array.prototype.slice.call(a._canvas.parentNode.children);
                return nodes.indexOf(a._canvas) - nodes.indexOf(b._canvas);
            });
        }
        if (!layers.length) return Promise.reject(new Error('toImage: no GL vector tile layer with a loaded style'));

        var layout;
        try {
            layout = imageLayout(toExtent(map, options.extent), options, mapResolution(map));
        } catch (e) {
            return Promise.reject(e);
        }

        var crs = map.options.crs;
        var div = document.createElement('div');
        div.style.cssText = 'position:absolute;left:-100000px;top:0;width:' + layout.cssSize[0] + 'px;height:' +
            layout.cssSize[1] + 'px;overflow:hidden;';
        document.body.appendChild(div);
        var hidden = L.map(div, {
            crs: crs, zoomControl: false, attributionControl: false, zoomAnimation: false, fadeAnimation: false,
            markerZoomAnimation: false, inertia: false, zoomSnap: 0, minZoom: -Infinity, maxZoom: Infinity
        });
        var e = layout.extent;
        var center = crs.unproject(L.point((e[0] + e[2]) / 2, (e[1] + e[3]) / 2));
        var factor = crs.transformation && crs.transformation._a ? Math.abs(crs.transformation._a) : 1;
        hidden.setView(center, crs.zoom(1 / (layout.resolution * factor)), { animate: false });

        var copies = layers.map(function (layer) { return printCopy(layer, layout.pixelRatio); });
        var drawn = copies.map(function (copy) { return whenDrawn(copy, options.timeout || 60000); });
        copies.forEach(function (copy) { copy.addTo(hidden); });

        return Promise.all(drawn).then(function (complete) {
            var canvas = document.createElement('canvas');
            canvas.width = layout.imageSize[0];
            canvas.height = layout.imageSize[1];
            var ctx = canvas.getContext('2d');
            if (options.background) {
                ctx.fillStyle = options.background;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            var attribution = [];
            copies.forEach(function (copy) {
                copy._moving = false;
                copy._redraw();   // labels placed for this size, all tiles there
                ctx.drawImage(copy._canvas, 0, 0, canvas.width, canvas.height);
                ctx.drawImage(copy._labelCanvas, 0, 0, canvas.width, canvas.height);
                var a = copy.getAttribution();
                if (a && attribution.indexOf(a) < 0) attribution.push(a);
            });
            return {
                canvas: canvas, extent: layout.extent, imageSize: layout.imageSize, dpi: layout.dpi, scale: layout.scale,
                attribution: attribution.join(' | '), complete: complete.every(Boolean)
            };
        }).then(function (result) {
            hidden.remove();
            L.DomUtil.remove(div);
            return result;
        }, function (error) {
            hidden.remove();
            L.DomUtil.remove(div);
            throw error;
        });
    };

    /** This layer for an extent as an image (see GLVectorTiles.mapToImage). */
    GLVectorTiles.prototype.toImage = function (options) {
        if (!this._map) return Promise.reject(new Error('toImage: the layer is not on a map'));
        return GLVectorTiles.mapToImage(this._map, options, [this]);
    };

    GLVectorTiles._internals = GLVectorTiles._internals || {};

    GLVectorTiles.decodeTile = decodeTile;
    /** A CSS color through a color scheme, e.g. the map container's background: schemeColor('#fff', 'dark'). */
    GLVectorTiles.schemeColor = function (color, scheme) { return schemeColor(color, colorSchemeFunction(scheme)); };
    GLVectorTiles.evaluate = evaluateValue;
    GLVectorTiles.shared = gvShared;
    // for the tests (not a public API)
    GLVectorTiles._internals = {
        resolveUrl: resolveUrl, placeAlongPath: placeAlongPath, cssFont: cssFont, imageLayout: imageLayout,
        localizeTextField: localizeTextField, anchorOffset: anchorOffset, justification: justification,
        fontParts: fontParts, webfontUrl: webfontUrl, styleFonts: styleFonts, requestFor: requestFor,
        defaultStyle: defaultStyle, isTileJson: isTileJson
    };

    L.GLVectorTiles = GLVectorTiles;
    L.glVectorTiles = function (url, options) {
        return new GLVectorTiles(url, options);
    };
    L.glVectorTiles.createCrs = GLVectorTiles.createCrs;
    L.glVectorTiles.decodeTile = decodeTile;
    L.glVectorTiles.schemeColor = GLVectorTiles.schemeColor;
    L.glVectorTiles.mapToImage = GLVectorTiles.mapToImage;

    return GLVectorTiles;
}));
