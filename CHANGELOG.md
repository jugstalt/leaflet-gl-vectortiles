# Changelog

## 0.4.0

- **Color schemes:** option `colorScheme` and `setColorScheme()` at runtime: `'pale'` (background for thematic
  data), `'grayscale'`, `'dark'` (lightness inverted, hues kept), `'contrast'` (accessibility: areas darker against
  white, text black/white), `'colorblind'` (red-green, daltonization), `'sepia'`, `'tint:<color>'` (shades of a house
  color) or an own function `(rgba, info) → rgba`. All colors of the style and the sprite images (icons, patterns)
  are recolored, in the worker too; `L.glVectorTiles.schemeColor(color, scheme)` for the map container's background.
- **Highlighting:** `highlight(layers, { dim })` keeps the colors of the given style layers and dims all others with
  a color scheme (default `'pale'`, icons fainter); `highlight(null)` to end it. Works together with a color scheme.
- **Images for printing:** `L.glVectorTiles.mapToImage(map, options)` (all GL layers) and `layer.toImage(options)`:
  extent + dpi → image size, extent + image size → dpi, extent + image size + dpi → scale; `scale` (default the
  map's); the extent widened to the image's aspect ratio (never distorted); labels placed for the image size, color
  scheme and highlighting included. Option `pixelRatio` (render at a fixed pixel ratio).
- **Label language:** option `language` and `setLanguage()`: name fields of `text-field` (`name`, `name_en`,
  `name:latin`, `{name}` tokens, …) prefer `name:<lang>` / `name_<lang>`, falling back to the original.
- **Style properties:** `icon-text-fit` (+ padding), `text-variable-anchor` (+ `text-radial-offset`), `text-justify`,
  `text-line-height`, `fill-/line-/circle-/text-/icon-translate`, `line-offset`, `line-pattern` (not rotated along
  the line).
- **Example page:** color scheme selector (with tint color), ★ button per theme to highlight it, export of the view
  as PNG, label language selector.
- **Releases** from a pushed tag `v<version>` with GitHub Actions: tests, npm publish with provenance (trusted
  publishing, no token or one-time password), GitHub release with the minified build.
- Fix: a symbol whose text can't be laid out (longer than its line) no longer shows its icon alone unless the text
  is optional (as GL; empty road shields in OpenFreeMap Positron).
- Fix: the `load` event waited only for running render jobs, not for queued ones.
- Fix: the color cache of a color scheme depends on the style layer (scheme functions using `info.layer`).

## 0.3.1

- Tile images are rendered in software on the worker thread (option `gpuTileRendering`, default false): Chrome and
  Edge rasterize a 2D OffscreenCanvas on the GPU, and the thousands of small paths of dense vector tiles kept the
  GPU process busy (6.6 s of 8.3 s in a trace of zooming into basemap.at), which slowed down the whole page.
  Firefox renders in software anyway. Example page: a checkbox to compare.

- During gestures, tiles that already have an image are drawn scaled and rendered again only at the end, instead
  of at every half zoom step: zooming in, the images grow (up to 2048² px at a device pixel ratio of 2) and Chrome
  and Edge upload every new image to the GPU (zooming in was slow there, not in Firefox).

## 0.3.0

- Tests (Node's test runner, `npm test`) and GitHub Actions CI; `npm publish` runs the tests first.
- Many more expressions: `coalesce`, `let`/`var`, `typeof`, `to-boolean`, `to-color`, type assertions, `upcase`,
  `downcase`, `length`, `slice`, `index-of`, `in` on strings, `format`, `number-format`, `image`, math
  (`+ - * / % ^`, `min`, `max`, `round`, …), `properties`, `id`; `interpolate` between colors and arrays and with
  `cubic-bezier` (also legacy functions with color stops).
- Sprites as a list (style spec v8: `[{ id, url }]`, icons named `id:icon`), put into one atlas.
- `fill-extrusion` layers (3D buildings) are drawn as flat fills.
- Labels are placed as in GL: the higher style layer first, within a layer by `symbol-sort-key`; `icon-opacity`.
- Style URLs without `.json` (e.g. OpenFreeMap): when `{url}/style.json` fails, the URL itself is loaded as style. A
  TileJSON given as style gets a clear error.
- A source that can't be loaded no longer stops the style: an `error` event (`e.source`), the other sources are drawn.
- Example page: presets for basemap.de, OpenFreeMap (Liberty, Positron) and VersaTiles.
- Styles with several sources render in the worker too, with the tile image cache: consecutive style layers of
  one source ("runs") get one image per tile (VersaTiles: a redraw ~100 ms instead of ~700 ms on the main thread).
- Gestures (dragging, wheel zoom, pinch, animated zoom) only load tiles and draw finished tile images (1–5 ms per
  redraw); labels move with the map, also across zoom levels, and are placed once when the gesture ends. Zooming
  out, they shrink with the map and fade out (gone one level out, no pile of labels), and fade in again after the
  placement. No more
  label placement in between (also not when the map rests for a moment while dragging).
- Zooming to another tile level: the last frame (scaled to the new zoom) fills the tiles whose images are not
  rendered yet (only those: below finished tiles it would double semi-transparent fills), the map no longer
  disappears while the labels are shown.
- Faster labels: a label along a line is drawn once into its own image (one image per frame instead of one per
  glyph and halo; kept while the label stays), labels that are invisible at the zoom (size or opacity 0) are not
  placed, points outside the canvas are skipped before the style is evaluated, line labels whose anchor already
  collides skip the glyph layout, paint/layout values that don't depend on the feature are evaluated once per
  zoom, colors are parsed once.
- Fix: legacy identity functions (`{ "type": "identity", "property": "…" }`, without stops) were not evaluated.

## 0.2.0

Published on npm as `@jugstalt/leaflet-gl-vectortiles`, with a minified build (`leaflet-gl-vectortiles.min.js`).

**Breaking:** the event `load` now means "all visible tiles loaded and drawn" (as Leaflet's tile layers); the style
is loaded at `styleload`.

- Style at runtime: `getLayers`, `getLayerVisibility`, `setLayerVisibility`, `setLayoutProperty`,
  `setPaintProperty`, `setFilter` (style layers by id, ids, RegExp or function), `setStyle` (URL or object; a style
  object can also be passed as option `style`).
- Events `styleload`, `loading`, `load`, `tileerror`.
- Attribution from the sources (TileJSON `attribution`, ESRI `copyrightText`) when the option is not set.
- Options `opacity`, `zIndex`, `minZoom`, `maxZoom`; methods `setOpacity`, `setZIndex`.
- Example page: themes (style layers grouped) to switch, loading indicator.

- Labels and icons on their own canvas: during a zoom animation they keep their size and move with the map
  (frame by frame), instead of being scaled with the tile images.
- Labels are drawn from cached images (text with halo, glyphs, icons cut out of the sprite sheet): no text
  drawing per frame, halos are drawn once.
- Stable labels: labels shown before keep their place when the map is panned.
- Tiles are loaded and drawn during gestures: while dragging, pinching and smooth wheel zooming, every
  `liveRedrawInterval` ms.
- Smooth panning: while the map is dragged, labels move with it and are not placed again (new ones when the map
  rests for a moment or at the end); the canvas is only redrawn when new tiles arrive or the padding runs out.
- Icon-only symbol layers with `icon-allow-overlap` are drawn into the tile images (option `iconsInTiles`,
  default on): basemap.at has 107 such layers (e.g. footpath dots), the label canvas holds 45 instead of ~1250
  entries in Vienna and a redraw takes ~12 ms instead of ~25 ms. SDF icons are tinted in the worker too.
- New tiles and labels fade in (option `fadeDuration`, default 200 ms); labels seen before a zoom step don't.
- Tiles around the view are preloaded after the visible ones (option `preload`, default 1 ring).
- Option `maxPixelRatio`: render at most at this device pixel ratio (e.g. 1 on high-DPI screens).
- Option `lowPower`: economical defaults for weak clients (`maxPixelRatio: 1`, `padding: 0`,
  `liveRedrawInterval: 0`, no fading, no preloading, fewer cached tiles and parallel requests/renders).
- Option `padding` (default 0.15): the canvas reaches beyond the map's edges, panning shows map there at once.
- Faster redraws: labels are only collected where they can be seen (tiles reach far beyond the canvas); a redraw
  of basemap.at in Vienna takes about 10–20 ms instead of 45 ms.
- Map handler `smoothWheelZoom` (map options `smoothWheelZoom: true`, `smoothWheelSpeed`): continuous wheel zoom
  around the mouse position.
- Fix: thin light seams at tile borders: tile images are placed on whole device pixels.
- Fix: far overzoomed tiles (only the visible part rendered) were drawn at the position and size of the zoom they
  were rendered for within the same half zoom step: layers drawn on top of each other did not match until panned.
- Fix: tile URLs relative to a TileJSON file (`…/tiles.json`) are resolved against its folder, not against the
  file as if it were a folder (e.g. BEV Kataster `../../tiles/…`).
- Example page: service presets (basemap.at, BEV Kataster), several styles on top of each other,
  OpenStreetMap background for WebMercator maps.

## 0.1.0

First version, extracted from the gView GIS repository (`src/Clients/Leaflet.gViewVectorTiles`).

- Mapbox Vector Tiles with GL styles in Leaflet: classic WebMercator sources (tiles, TileJSON, ESRI
  VectorTileServer) and gView vector tile caches in any projection and grid (`gview:grid`).
- Fill, line, circle and symbol layers with sprites (icons, patterns, SDF icons), labels with collision handling,
  line labels along the line, legacy styles (functions, filters, tokens).
- Rendering in a web worker (OffscreenCanvas) with a main thread fallback, tile image cache, prioritized and
  abortable tile requests.
