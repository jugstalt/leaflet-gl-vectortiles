# Changelog

## Unreleased

- Labels and icons on their own canvas: during a zoom animation they keep their size and move with the map
  (frame by frame), instead of being scaled with the tile images.
- Labels are drawn from cached images (text with halo, glyphs, icons cut out of the sprite sheet): no text
  drawing per frame, halos are drawn once.
- Stable labels: labels shown before keep their place when the map is panned.
- Sharp redraws during zoom gestures without animation (pinch, smooth wheel zoom), every `liveZoomInterval` ms.
- Map handler `smoothWheelZoom` (map options `smoothWheelZoom: true`, `smoothWheelSpeed`): continuous wheel zoom
  around the mouse position.
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
