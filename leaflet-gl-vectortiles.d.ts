// Type definitions for @jugstalt/leaflet-gl-vectortiles (Leaflet 1.9)
// https://github.com/jugstalt/leaflet-gl-vectortiles
//
// The plugin adds L.GLVectorTiles, L.glVectorTiles() and the map options smoothWheelZoom / smoothWheelSpeed:
//   import L from 'leaflet';
//   import '@jugstalt/leaflet-gl-vectortiles';

import * as L from 'leaflet';

declare module 'leaflet' {
    namespace GLVectorTiles {
        /** [r, g, b, a]: 0–255, alpha 0–1 */
        type RGBA = [number, number, number, number];

        /** A color scheme function; it also runs in the web worker: no variables from outside. */
        type ColorSchemeFunction = (rgba: RGBA, info: { property?: string; layer?: string }) => RGBA | null | undefined;

        type ColorScheme = 'pale' | 'grayscale' | 'dark' | 'contrast' | 'colorblind' | 'sepia' | `tint:${string}` | ColorSchemeFunction;

        /** A style layer of a GL style (as far as the plugin reads it). */
        interface StyleLayer {
            id: string;
            type: string;
            source?: string;
            'source-layer'?: string;
            minzoom?: number;
            maxzoom?: number;
            filter?: unknown;
            layout?: { [property: string]: unknown };
            paint?: { [property: string]: unknown };
            metadata?: unknown;
            [key: string]: unknown;
        }

        /** A GL style (Mapbox / MapLibre style spec, version 8). */
        interface Style {
            version: number;
            name?: string;
            sources: { [id: string]: unknown };
            layers: StyleLayer[];
            sprite?: string | Array<{ id: string; url: string }>;
            glyphs?: string;
            metadata?: { [key: string]: unknown };
            [key: string]: unknown;
        }

        type ResourceType = 'Style' | 'Source' | 'Tile' | 'SpriteJSON' | 'SpriteImage' | 'Font';

        /** The result of transformRequest: another URL and/or fetch options (headers added to those of fetchOptions). */
        interface RequestParameters extends RequestInit {
            url?: string;
        }

        type TransformRequestFunction = (url: string, resourceType: ResourceType) =>
            RequestParameters | null | undefined | void | Promise<RequestParameters | null | undefined | void>;

        /** Style layers: an id, ids, a RegExp tested on the id, or a function. */
        type LayerMatch = string | string[] | RegExp | ((styleLayer: StyleLayer) => boolean);

        interface LayerInfo {
            id: string;
            type: string;
            source?: string;
            sourceLayer?: string;
            visible: boolean;
            minzoom?: number;
            maxzoom?: number;
            metadata?: unknown;
        }

        /** The tile grid of a source (gView: metadata 'gview:grid' of the style). */
        interface Grid {
            epsg: number | string;
            origin: [number, number];
            resolutions: number[];
            tileSize: [number, number];
            extent?: [number, number, number, number];
            webmercator?: boolean;
        }

        interface Options extends LayerOptions {
            /** EPSG code of a gView cache; default: the map's crs.code */
            epsg?: number | string | null;
            /** a style URL (any GL style) or a style object, instead of {url}/style.json of a gView service */
            style?: string | Style | null;
            /** the base URL for relative URLs in a style object (default: the page) */
            styleBase?: string | null;
            pane?: string;
            /** hide labels and icons overlapping others (default true) */
            declutter?: boolean;
            /** draw the tile borders and coordinates */
            debug?: boolean;
            maxCachedTiles?: number;
            maxConcurrentRequests?: number;
            /** a failed tile request is repeated this often (after 0.5 s, 1 s, ...) before a tileerror event (default 0) */
            tileRetries?: number;
            /** milliseconds per frame for rendering tile images on the main thread (fallback) */
            renderBudget?: number;
            /** render in a web worker where the browser supports it (default true) */
            worker?: boolean;
            maxConcurrentRenders?: number;
            /** options for fetch, e.g. { credentials: 'include' } */
            fetchOptions?: RequestInit;
            /** a TileJSON instead of a style: a schematic default style from its vector_layers (default true) */
            defaultStyle?: boolean;
            /** per request (on the main thread): URL, headers, fetch options; also async (a token renewed first) */
            transformRequest?: TransformRequestFunction | null;
            /** default: the attribution of the sources */
            attribution?: string;
            opacity?: number;
            zIndex?: number | null;
            minZoom?: number | null;
            maxZoom?: number | null;
            /** ms between redraws during gestures; 0: only at their end */
            liveRedrawInterval?: number;
            /** the canvas beyond each edge, as part of the map size (default 0.15) */
            padding?: number;
            /** render at most at this device pixel ratio */
            maxPixelRatio?: number | null;
            /** render at exactly this pixel ratio (e.g. dpi / 96) */
            pixelRatio?: number | null;
            /** economical defaults for weak clients */
            lowPower?: boolean;
            /** icon-only symbol layers with icon-allow-overlap drawn into the tile images (default true) */
            iconsInTiles?: boolean;
            /** render tile images on the GPU (default false: software, faster for dense tiles in Chrome/Edge) */
            gpuTileRendering?: boolean;
            /** ms to fade in new tiles and labels; 0: no fading */
            fadeDuration?: number;
            /** rings of tiles loaded around the visible ones */
            preload?: number;
            /** true: the style's ol:webfonts template; a template of your own; false: browser fonts only */
            webfonts?: boolean | string;
            /** labels in this language where the style has name:<lang> / name_<lang> fields */
            language?: string | null;
            /** the style in other colors */
            colorScheme?: ColorScheme | null;
        }

        interface ImageOptions {
            /** LatLngBounds or [minX, minY, maxX, maxY] in projection units; default: the map's view */
            extent?: LatLngBoundsExpression | [number, number, number, number];
            imageSize?: [number, number];
            dpi?: number;
            /** 1:scale; default: the map's */
            scale?: number;
            /** CSS color; default: transparent where the style paints nothing */
            background?: string;
            /** ms, default 60000 */
            timeout?: number;
        }

        interface ImageResult {
            canvas: HTMLCanvasElement;
            /** the extent of the image (widened to its aspect ratio), in projection units */
            extent: [number, number, number, number];
            imageSize: [number, number];
            dpi: number;
            scale: number;
            attribution: string;
            /** false: not all tiles were loaded within the timeout */
            complete: boolean;
        }

        interface DecodedFeature {
            id: number | null;
            type: 'Point' | 'LineString' | 'Polygon' | 'Unknown';
            properties: { [key: string]: string | number | boolean | null };
            geometry: Array<Array<[number, number]>>;
        }

        interface DecodedLayer {
            name: string;
            extent: number;
            features: DecodedFeature[];
        }

        interface StyleLoadEvent extends LeafletEvent { style: Style; }
        interface TileErrorEvent extends LeafletEvent { key: string; url?: string; error: Error; }
        interface ErrorEvent extends LeafletEvent { error: Error; source?: string; }
    }

    class GLVectorTiles extends Layer {
        /**
         * @param url the vtc base of a gView service (https://server/gview/vtc/[folder/]service), any GL style URL
         *            (…/style.json, …/root.json, or without .json), or '' with options.style
         */
        constructor(url?: string, options?: GLVectorTiles.Options);

        options: GLVectorTiles.Options;

        /** the loaded GL style (after 'styleload') */
        getStyle(): GLVectorTiles.Style | null;
        /** the tile grid of the (first) source */
        getGrid(): GLVectorTiles.Grid | null;

        getLayers(): GLVectorTiles.LayerInfo[];
        getLayerVisibility(id: string): boolean | null;
        setLayerVisibility(layers: GLVectorTiles.LayerMatch, visible: boolean): this;
        setLayoutProperty(layers: GLVectorTiles.LayerMatch, name: string, value: unknown): this;
        setPaintProperty(layers: GLVectorTiles.LayerMatch, name: string, value: unknown): this;
        setFilter(layers: GLVectorTiles.LayerMatch, filter: unknown[] | null): this;
        /** another style: style URL, gView vtc service URL or style object */
        setStyle(style: string | GLVectorTiles.Style): this;

        setOpacity(opacity: number): this;
        setZIndex(zIndex: number | null): this;

        setColorScheme(scheme: GLVectorTiles.ColorScheme | null): this;
        getColorScheme(): GLVectorTiles.ColorScheme | null;
        /** the given style layers keep their colors, the others are dimmed; null: all normal */
        highlight(layers: GLVectorTiles.LayerMatch | null, options?: { dim?: GLVectorTiles.ColorScheme }): this;
        setLanguage(language: string | null): this;

        /** this layer for an extent as an image */
        toImage(options?: GLVectorTiles.ImageOptions): Promise<GLVectorTiles.ImageResult>;

        // events: 'styleload' (GLVectorTiles.StyleLoadEvent), 'tileerror' (TileErrorEvent), 'error' (ErrorEvent),
        // 'loading', 'load'; e.g. layer.on('styleload', (e: L.LeafletEvent) => (e as L.GLVectorTiles.StyleLoadEvent).style)

        /** a Proj4Leaflet CRS for a gView grid (needs Proj4Leaflet) */
        static createCrs(grid: GLVectorTiles.Grid, proj4Definition: string, options?: { overzoomLevels?: number }): CRS;
        /** a Mapbox Vector Tile decoded: source layer name → layer */
        static decodeTile(buffer: ArrayBuffer): { [sourceLayer: string]: GLVectorTiles.DecodedLayer };
        /** a CSS color through a color scheme, e.g. the map container's background */
        static schemeColor(color: string, scheme: GLVectorTiles.ColorScheme | null): string;
        /** the GL layers of a map (or the given ones) for an extent as an image */
        static mapToImage(map: Map, options?: GLVectorTiles.ImageOptions, layers?: GLVectorTiles[]): Promise<GLVectorTiles.ImageResult>;
        /** the smooth wheel zoom handler (map option smoothWheelZoom) */
        static SmoothWheelZoom: typeof Handler;
    }

    function glVectorTiles(url?: string, options?: GLVectorTiles.Options): GLVectorTiles;

    namespace glVectorTiles {
        const createCrs: typeof GLVectorTiles.createCrs;
        const decodeTile: typeof GLVectorTiles.decodeTile;
        const schemeColor: typeof GLVectorTiles.schemeColor;
        const mapToImage: typeof GLVectorTiles.mapToImage;
    }

    interface MapOptions {
        /** continuous wheel zoom around the mouse position (replaces scrollWheelZoom) */
        smoothWheelZoom?: boolean;
        /** about half a zoom level per wheel notch at 1 */
        smoothWheelSpeed?: number;
    }

    interface Map {
        smoothWheelZoom: Handler;
    }
}

export {};
