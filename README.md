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
  rotation, letter spacing, transform, `text-max-width` wrapping), background.
  - Expressions: `get`, `has`, comparisons, `!`, `all`, `any`, `in`, `to-string`, `to-number`, `concat`,
    `geometry-type`, `interpolate`, `match`, `case`, `step`, `literal`, `zoom`.
  - Legacy styles: functions (`stops`), filters (`["==", "field", value]`), `{field}` tokens.
- **Labels:** collision handling ("declutter") across tiles. Icon and text of a symbol are placed together, with
  `*-optional` and `*-ignore-placement`. Line labels follow the line glyph by glyph (upright, `text-max-angle`),
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

## Usage

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="leaflet-gl-vectortiles.js"></script>
```

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

A URL ending in `.json` is a style URL; anything else is the `vtc` base of a gView service. For gView services the
plugin loads `{url}/style.json?epsg={EPSG of the map}`, with the EPSG code taken from the map's `crs.code`.

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
| `liveRedrawInterval` | `150` | milliseconds between redraws while the map is dragged or zoomed without animation (pinch, smooth wheel zoom): tiles are loaded and drawn during the gesture; `0`: only at its end |
| `padding` | `0.15` | the canvas reaches this part of the map size beyond each edge, so panning shows map there at once |
| `fetchOptions` | `{}` | options for `fetch`, e.g. `{ credentials: 'include' }` or headers for authorization |
| `debug` | `false` | draw the tile borders and coordinates |
| `pane` | `'overlayPane'` | the Leaflet pane |
| `attribution` | `null` | |

Events: `load` (style loaded), `error` (`e.error`). Methods: `getStyle()`, `getGrid()`.
Static: `L.glVectorTiles.createCrs(grid, proj4Definition, options)`, `L.glVectorTiles.decodeTile(arrayBuffer)`.

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

While zooming this way (or pinching on a touch screen), and while the map is dragged, tiles are loaded and the map
is redrawn every `liveRedrawInterval` ms.

## Limits

- **Projection:** the map's projection must be the projection of the tiles. Tiles are not reprojected on the
  client, so WebMercator tiles can't be shown in a map in another projection.
- **Rendering:** Canvas 2D, not WebGL. Complex styles render well, but a new zoom step takes longer to fill in than
  in MapLibre. Labels are placed on the main thread on every redraw.
- **Not supported:** `line-offset`, `*-translate`, `fill-extrusion`, `heatmap`, `hillshade` and `raster` layers,
  `feature-state`.
- **Fonts:** CSS fonts are used. `text-font` "Arial Bold" becomes `bold … "Arial"`. Glyph PBFs of the style are not
  used.

## Example

`examples/index.html` loads a GL style URL or a gView service. For a gView service it builds the map's CRS from the
cache grid. Serve the repository folder over HTTP, e.g. `python -m http.server`, and open `/examples/`.

## License

[Apache License 2.0](LICENSE)
