# leaflet-gl-vectortiles

A Leaflet layer for **vector tiles (Mapbox Vector Tiles, MVT) styled with GL styles**, in **one file, without
dependencies** besides Leaflet 1.9:

- **classic WebMercator vector tiles** (z/x/y) with their GL style, e.g. [basemap.at](https://basemap.at),
  OpenMapTiles or ESRI vector tile services;
- **vector tiles in any projection, any scales and any tile size**, e.g. a Leaflet map in a national projection
  (with [Proj4Leaflet](https://github.com/kartena/Proj4Leaflet)) showing the vector tile cache of a
  [gView GIS](https://github.com/jugstalt/gview-gis) server.

Most Leaflet vector tile plugins only know the WebMercator grid. This plugin reads the tile grid of the source
and draws the tiles into the map at the map's resolution, so the map's zoom levels don't have to match the tile
levels. Protobuf and MVT are decoded in the plugin; rendering runs in a web worker.

## Features

- **Sources:** `tiles` URLs, TileJSON (`url`), ESRI VectorTileServer sources, several sources per style, relative
  URLs. 404/204 tiles count as empty. gView vector tile caches in any grid (`gview:grid` in the style).
- **Styles:** fill (color, opacity, outline, pattern), line (width, color, opacity, dashes, join, cap), circle,
  symbol (icons from the sprite, SDF icons tinted with `icon-color`, text with font, size, halo, anchor, offset,
  rotation, letter spacing, transform, `text-max-width` wrapping), background. `fill-extrusion` (3D buildings) is
  drawn flat, as seen from above. Sprites as a URL or as a list (`[{ id, url }]`, icons `id:name`).
  - Expressions: data (`get`, `has`, `properties`, `id`, `geometry-type`, `zoom`), decisions (`match`, `case`,
    `coalesce`, comparisons, `all`, `any`, `!`, `in`), ramps (`step`, `interpolate` linear/exponential/cubic-bezier,
    also between colors), types (`typeof`, `to-string`, `to-number`, `to-boolean`, `to-color`, assertions), strings
    (`concat`, `upcase`, `downcase`, `length`, `slice`, `index-of`, `format`, `number-format`), math (`+ - * / % ^`,
    `min`, `max`, `round`, `floor`, `ceil`, `abs`, `sqrt`, `ln`, …), `let`/`var`, `literal`, `image`.
  - Legacy styles: functions (`stops`, `identity`), filters (`["==", "field", value]`), `{field}` tokens.
  - Tested with basemap.at, basemap.de, the BEV cadastre, OpenFreeMap and VersaTiles.
- **Labels:** collision handling ("declutter") across tiles, the higher style layer first (as GL), within a layer by
  `symbol-sort-key`. Icon and text of a symbol are placed together, with `*-optional` and `*-ignore-placement`. Line labels follow the line glyph by glyph (upright, `text-max-angle`),
  repeated with `symbol-spacing`.
- **Zoom levels:** classic sources load the tiles of `floor(zoom)` like GL clients. Sources with their own grid
  use the nearest level. Beyond the last level the tiles are overzoomed, and while a level loads, coarser tiles are
  shown.
- **Performance:**
  - **Web worker:** tiles are loaded, decoded, filtered and rendered in a web worker (`OffscreenCanvas`), so dense
    maps (e.g. basemap.at in a city: hundreds of style layers, 600–900 KB tiles) don't block the page.
  - **Main thread:** only labels and putting the tile images together run there.
  - **Worker source:** the worker is created from the plugin's own code (blob URL).
  - **Image cache:** each tile is rendered once per half zoom step and reused while panning.
  - **Requests:** they are prioritized by distance to the center, limited in number and aborted when no longer
    visible.
  - **Fallback:** without `Worker`/`OffscreenCanvas`, with a Content Security Policy without `worker-src blob:`,
    and for styles with several sources, everything runs on the main thread, rendering in small portions per
    frame.

**Try it:** [example page](https://jugstalt.github.io/leaflet-gl-vectortiles/examples/) with basemap.at, the
Austrian cadastre (BEV), basemap.de, OpenFreeMap and VersaTiles.

## Usage

From a CDN (minified build of the npm package):

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@jugstalt/leaflet-gl-vectortiles@0.2.0/leaflet-gl-vectortiles.min.js"></script>
```

With npm (`L.glVectorTiles` is added to Leaflet's `L`):

```bash
npm install leaflet @jugstalt/leaflet-gl-vectortiles
```

```js
import L from 'leaflet';
import '@jugstalt/leaflet-gl-vectortiles';
```

Or copy `leaflet-gl-vectortiles.js` (one file) into your project.

### Classic vector tiles (WebMercator)

```js
const map = L.map('map').setView([48.2082, 16.3738], 13);

L.glVectorTiles('https://mapsneu.wien.gv.at/basemapvectorneu/root.json', {
  attribution: '<a href="https://basemap.at">basemap.at</a>'
}).addTo(map);
```

### Any projection (gView vector tile cache)

The map's CRS must be the projection of the cache; its zoom levels can be anything:

```html
<!-- maps in another projection than WebMercator -->
<script src="https://cdn.jsdelivr.net/npm/proj4@2.12.1/dist/proj4.js"></script>
<script src="https://cdn.jsdelivr.net/npm/proj4leaflet@1.0.2/src/proj4leaflet.js"></script>
```

```js
const crs = new L.Proj.CRS('EPSG:31256', '+proj=tmerc +lat_0=0 +lon_0=16.3333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs', {
  origin: [-1000000, 1000000],
  resolutions: [500, 250, 100, 50, 20, 10, 5, 2.5, 1, 0.5]
});
const map = L.map('map', { crs, maxZoom: 9 });

// the vtc base URL of a gView service: {gView Server}/vtc/[{folder}/]{service}
L.glVectorTiles('https://myserver/gview/vtc/myfolder/myservice').addTo(map);
```

A URL ending in `.json` is a style URL; anything else is first taken as the `vtc` base of a gView service: the
plugin loads `{url}/style.json?epsg={EPSG of the map}`, with the EPSG code taken from the map's `crs.code`. If that
fails, the URL itself is loaded as a style (style URLs without `.json`, e.g. `https://tiles.openfreemap.org/styles/liberty`).

A map whose zoom levels are exactly the cache levels (plus 3 overzoom levels):

```js
const style = await (await fetch(url + '/style.json')).json();
const grid = style.metadata['gview:grid'];
const crs = L.glVectorTiles.createCrs(grid, proj4Definition, { overzoomLevels: 3 });
const map = L.map('map', { crs, maxZoom: crs.options.resolutions.length - 1 });
L.glVectorTiles(url, { epsg: grid.epsg }).addTo(map);
```

A Proj4Leaflet CRS only knows the zoom levels it has resolutions for: set the map's `maxZoom` to its last level,
otherwise zooming beyond it gives no scale in Leaflet.

## Options

| Option | Default | |
|---|---|---|
| `style` | | a style URL, if the first argument is a gView service |
| `epsg` | EPSG code of the map's `crs.code` | gView services: the projection of the cache |
| `declutter` | `true` | hide labels and icons overlapping earlier ones |
| `worker` | `true` | render in a web worker where the browser supports it |
| `maxConcurrentRequests` | `8` | tile requests at the same time |
| `maxConcurrentRenders` | `4` | tile images rendered in the worker at the same time |
| `renderBudget` | `12` | milliseconds per frame for rendering tile images on the main thread (fallback) |
| `maxCachedTiles` | `384` | tiles kept in memory |
| `liveRedrawInterval` | `150` | milliseconds between redraws while the map is dragged or zoomed without animation (pinch, smooth wheel zoom): tiles are loaded and their finished images drawn during the gesture (labels only move with the map); `0`: only at its end |
| `fadeDuration` | `200` | milliseconds to fade in new tiles and labels; `0`: no fading |
| `preload` | `1` | rings of tiles loaded around the visible ones (after them); `0`: none |
| `iconsInTiles` | `true` | icon-only symbol layers with `icon-allow-overlap` are drawn into the tile images (much less work per frame, e.g. the footpath dots of basemap.at); they don't hide other labels then, as with `icon-ignore-placement` |
| `maxPixelRatio` | `null` | render at most at this device pixel ratio, e.g. `1` on high-DPI screens; `null`: the screen's |
| `lowPower` | `false` | economical defaults for weak clients, see [Performance](#performance) |
| `padding` | `0.15` | the canvas reaches this part of the map size beyond each edge, so panning shows map there at once |
| `fetchOptions` | `{}` | options for `fetch`, e.g. `{ credentials: 'include' }` or headers for authorization |
| `debug` | `false` | draw the tile borders and coordinates |
| `pane` | `'overlayPane'` | the Leaflet pane |
| `attribution` | `null` | `null`: the attribution of the sources (TileJSON `attribution`, ESRI `copyrightText`); basemap.at has none in its metadata, set it here |
| `opacity` | `1` | opacity of the layer (`setOpacity`) |
| `zIndex` | `null` | z-index of the layer's canvases within the pane (`setZIndex`) |
| `minZoom`, `maxZoom` | `null` | the layer is only shown (and loaded) within these map zoom levels |

Events:

| Event | |
|---|---|
| `styleload` | the style, sources and sprite are loaded (`e.style`); from now on the style can be changed |
| `loading` | visible tiles start to load |
| `load` | all visible tiles are loaded and drawn |
| `tileerror` | a tile could not be loaded (`e.key`, `e.url`, `e.error`); 404 and 204 count as empty tiles |
| `error` | the style or a source could not be loaded (`e.error`) |

Methods: `getStyle()`, `getGrid()`, `setOpacity(opacity)`, `setZIndex(zIndex)` and the style methods below.
Static: `L.glVectorTiles.createCrs(grid, proj4Definition, options)`, `L.glVectorTiles.decodeTile(arrayBuffer)`.

### Style at runtime

After `styleload` style layers can be switched and changed, e.g. themes of a background map in a WebGIS. Style
layers are addressed by id, an array of ids, a RegExp (tested on the id) or a function `(styleLayer) => bool`:

```js
layer.on('styleload', () => {
  layer.setLayerVisibility(/^GEBAEUDE\//, false);                  // all building layers of basemap.at
  layer.setPaintProperty('Grundstücke', 'line-color', '#0066ff');
  layer.setFilter('Gebäudenutzung', ['==', 'ns', 41]);
});
```

| Method | |
|---|---|
| `getLayers()` | the style layers: `[{ id, type, source, sourceLayer, visible, minzoom, maxzoom, metadata }]` |
| `getLayerVisibility(id)` | `true`/`false` |
| `setLayerVisibility(layers, visible)` | |
| `setLayoutProperty(layers, name, value)` | `null` removes the property |
| `setPaintProperty(layers, name, value)` | `null` removes the property |
| `setFilter(layers, filter)` | `null` removes the filter |
| `setStyle(style)` | another style: style URL, gView vtc service URL or style object (loaded again: `styleload`) |

Changes keep the shown tiles until they are rendered again with the new style. The example page lists the style
layers as themes (grouped by the first part of their id) to switch them.

### Smooth zooming

Labels and icons are drawn on their own canvas: while the map zooms they keep their size and move with the map.
For continuous zooming with the mouse wheel (instead of Leaflet's animated steps) the plugin adds a map handler:

```js
const map = L.map('map', {
  zoomSnap: 0,              // any zoom, not only whole levels
  smoothWheelZoom: true,    // replaces scrollWheelZoom
  smoothWheelSpeed: 1       // about half a zoom level per wheel notch
});
```

While zooming this way (or pinching on a touch screen), and while the map is dragged, tiles are loaded and their
finished images drawn every `liveRedrawInterval` ms. Labels are not placed again during a gesture: they move with the
map and keep their size, and are placed once when the gesture ends (`moveend`).

### Performance

The defaults aim at a smooth map on desktop computers. For weak clients (old laptops, thin clients, terminal
servers without GPU) `lowPower: true` sets economical defaults; options set explicitly take precedence:

```js
L.glVectorTiles(url, { lowPower: true, padding: 0.1 })   // economical, but with a little padding
```

| Option | Default | `lowPower` | Effect |
|---|---|---|---|
| `maxPixelRatio` | screen | `1` | biggest lever: at a device pixel ratio of 2 (3) there are 4 (9) times the pixels to render; less sharp |
| `liveRedrawInterval` | `150` | `0` | no loading and drawing during gestures, only at their end |
| `padding` | `0.15` | `0` | the canvas is only as big as the map: less memory, panning shows empty edges until the end |
| `maxCachedTiles` | `384` | `128` | less memory, tiles are loaded again more often |
| `maxConcurrentRequests` | `8` | `4` | fewer parallel downloads |
| `maxConcurrentRenders` | `4` | `2` | fewer tile images rendered at the same time in the worker |
| `fadeDuration` | `200` | `0` | no fading: no extra frames while tiles and labels appear |
| `preload` | `1` | `0` | only visible tiles are loaded |

Keep `worker: true`: rendering in the web worker keeps the page responsive also on weak clients. The smooth wheel
zoom (map option `smoothWheelZoom`) is off by default.

## Limits

- **Projection:** the map's projection must be the projection of the tiles. Tiles are not reprojected on the
  client, so WebMercator tiles can't be shown in a map in another projection.
- **Rendering:** Canvas 2D, not WebGL. Complex styles render well, but a new zoom step takes longer to fill in than
  in MapLibre. Labels are placed on the main thread on every redraw.
- **Not supported:** `line-offset`, `*-translate`, `text-variable-anchor`, `icon-text-fit`, `heatmap`, `hillshade`
  and `raster` layers, `geojson` and `raster` sources, `feature-state` (always null). `fill-extrusion` is drawn flat;
  `format` joins its sections (no font or scale per section). A source that can't be loaded is left out (`error`
  event), the others are drawn.
- **Fonts:** CSS fonts are used. `text-font` "Arial Bold" becomes `bold … "Arial"`. Glyph PBFs of the style are not
  used.

## Example

`examples/index.html` ([online](https://jugstalt.github.io/leaflet-gl-vectortiles/examples/)) loads a GL style URL
or a gView service, with presets for basemap.at, the BEV cadastre, basemap.de, OpenFreeMap and VersaTiles. For a gView service it builds the map's CRS
from the cache grid. It lists the style layers as themes to switch. Locally: serve the repository folder over HTTP,
e.g. `python -m http.server`, and open `/examples/` (`/examples/?min` uses the minified build of `npm run build`).

## Build

```bash
npm install
npm run build    # leaflet-gl-vectortiles.min.js and its source map
npm test         # build, then the tests (Node's test runner, no browser needed)
```

The tests (`test/`) load the plugin in Node with a minimal Leaflet stub and cover the parts that don't draw: the
MVT decoder (with tiles encoded in the test), expressions, legacy functions and filters, source loading (TileJSON,
ESRI, gView grids, attribution), symbol anchors, text along lines, and that the worker code is self-contained, also
in the minified build. GitHub Actions runs them on every push.

## License

[Apache License 2.0](LICENSE)
