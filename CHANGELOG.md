# Changelog

## 0.1.0

First version, extracted from the gView GIS repository (`src/Clients/Leaflet.gViewVectorTiles`).

- Mapbox Vector Tiles with GL styles in Leaflet: classic WebMercator sources (tiles, TileJSON, ESRI
  VectorTileServer) and gView vector tile caches in any projection and grid (`gview:grid`).
- Fill, line, circle and symbol layers with sprites (icons, patterns, SDF icons), labels with collision handling,
  line labels along the line, legacy styles (functions, filters, tokens).
- Rendering in a web worker (OffscreenCanvas) with a main thread fallback, tile image cache, prioritized and
  abortable tile requests.
