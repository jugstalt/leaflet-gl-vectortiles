# Changelog

## Unreleased

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
