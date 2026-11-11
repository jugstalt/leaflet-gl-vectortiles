// Compiled with tsc (npm test): the type definitions cover the documented API. Not run.
import * as L from 'leaflet';

const map = L.map('map', { zoomSnap: 0, smoothWheelZoom: true, smoothWheelSpeed: 1 });

const layer: L.GLVectorTiles = L.glVectorTiles('https://example.com/styles/root.json', {
    attribution: 'basemap.at',
    colorScheme: 'pale',
    language: 'de',
    webfonts: true,
    lowPower: false,
    gpuTileRendering: false,
    fetchOptions: { credentials: 'include' }
}).addTo(map);

layer.on('styleload', e => {
    const name: string | undefined = (e as L.GLVectorTiles.StyleLoadEvent).style.name;
    layer.setLayerVisibility(/^GEBAEUDE\//, false)
        .setPaintProperty('roads', 'line-color', '#ff0000')
        .setFilter(['a', 'b'], ['==', ['get', 'class'], 'primary'])
        .setLayoutProperty(l => l.type === 'symbol', 'visibility', 'none')
        .highlight(/^GEWAESSER\//, { dim: 'grayscale' })
        .setColorScheme('tint:#1f6feb')
        .setLanguage(null);
    const visible: boolean | null = layer.getLayerVisibility('roads');
    const ids: string[] = layer.getLayers().map(l => l.id);
    void name; void visible; void ids;
});
layer.on('tileerror', (e: L.LeafletEvent) => { const t = e as L.GLVectorTiles.TileErrorEvent; console.log(t.url, t.error.message); });
layer.on('loading load', () => {});

layer.setColorScheme((c, info) => info.property === 'text-color' ? [0, 0, 0, c[3]] : c);
layer.setColorScheme(null);
layer.setOpacity(0.8).setZIndex(5).setStyle({ version: 8, sources: {}, layers: [] });

async function print(): Promise<void> {
    const result = await L.glVectorTiles.mapToImage(map, { extent: map.getBounds(), dpi: 300, scale: 5000 });
    const c: HTMLCanvasElement = result.canvas;
    const [w, h] = result.imageSize;
    const own = await layer.toImage({ extent: [0, 0, 1000, 500], imageSize: [2000, 1000] });
    void c; void w; void h; void own.complete;
}
void print;

const grid: L.GLVectorTiles.Grid | null = layer.getGrid();
if (grid) {
    const crs: L.CRS = L.glVectorTiles.createCrs(grid, '+proj=tmerc +units=m', { overzoomLevels: 3 });
    void crs;
}
const tile = L.GLVectorTiles.decodeTile(new ArrayBuffer(0));
const first = Object.values(tile)[0];
if (first) { const t: string = first.features[0].type; void t; }
const bg: string = L.glVectorTiles.schemeColor('#ffffff', 'dark');
map.smoothWheelZoom.disable();
void bg;

// @ts-expect-error: not a color scheme
layer.setColorScheme('neon');
// @ts-expect-error: visible must be a boolean
layer.setLayerVisibility('roads', 'yes');
