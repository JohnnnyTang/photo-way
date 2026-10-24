/* Spike S2 test app 鈥?a plain classic script (no imports). It defines window.SpikeApp.
 * The v6 page bundles it with Vite (entry-v6.js); the v5 page inlines it next to the UMD build.
 * Options come from location.hash, e.g. #raster=esri&terrain=1&globe=1&view=7.66,45.98,11,60,0
 * Instrumentation lives on window.__spike so Playwright can read it.
 */
(function () {
  "use strict";
  var T0 = performance.now();
  var S = (window.__spike = {
    scriptStartMs: T0,
    errors: [],
    tileErrors: [],
    tiles: {},
    idle: false,
    marks: {},
    thumbs: { created: 0, decodeMs: 0, markers: 0 },
  });
  window.addEventListener("error", function (e) { S.errors.push("window.onerror: " + e.message); });
  window.addEventListener("unhandledrejection", function (e) { S.errors.push("unhandledrejection: " + (e.reason && e.reason.message || e.reason)); });

  // ---------- hash options ----------
  var opt = {};
  (location.hash || "").replace(/^#/, "").split("&").forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf("=");
    opt[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? "1" : decodeURIComponent(kv.slice(i + 1));
  });
  S.opt = opt;

  // ---------- themes (basemap colours follow the theme) ----------
  var THEMES = {
    light: { bg: "#cfe3ee", land: "#f3efe6", coast: "#9fb7c4", lake: "#cfe3ee", river: "#9cc3d8", border: "#a08c9e", route: "#d9480f", ui: "#fff" },
    dark: { bg: "#0e1a24", land: "#1f2a33", coast: "#36505f", lake: "#0e1a24", river: "#24465a", border: "#6b5b70", route: "#ffa94d", ui: "#111" },
    dusk: { bg: "#2b2140", land: "#4a3b5c", coast: "#6d5a85", lake: "#2b2140", river: "#5b4f80", border: "#c49bb0", route: "#ffd43b", ui: "#222" },
  };
  var theme = THEMES[opt.theme] || THEMES.light;

  // ---------- data ----------
  function readJsonScript(id) {
    var el = document.getElementById(id);
    return el ? JSON.parse(el.textContent) : null;
  }
  function basemapGeojson(topoFeature) {
    var t = performance.now();
    var topo = window.__PW_BASEMAP__ || readJsonScript("pw-basemap");
    if (!topo) return { type: "FeatureCollection", features: [] };
    var fc;
    if (topo.type === "Topology") {
      var feats = [];
      Object.keys(topo.objects).forEach(function (k) {
        var f = topoFeature(topo, topo.objects[k]);
        (f.features || [f]).forEach(function (x) { x.properties = { k: k }; feats.push(x); });
      });
      fc = { type: "FeatureCollection", features: feats };
    } else fc = topo;
    S.marks.basemapDecodeMs = performance.now() - t;
    return fc;
  }

  // Pack refs "#pack:<pack>:<offset>:<length>" -> blob: URL, decoding only the needed base64 slice.
  var packText = {};
  var urlCache = new Map();
  function packString(name) {
    if (!(name in packText)) {
      var el = document.getElementById("pw-pack-" + name);
      packText[name] = el ? el.textContent : "";
    }
    return packText[name];
  }
  function resolveRef(ref) {
    if (ref.lastIndexOf("#pack:", 0) !== 0) return ref;
    var u = urlCache.get(ref);
    if (u) return u;
    var t = performance.now();
    var p = ref.split(":"), off = +p[2], len = +p[3];
    var b64 = packString(p[1]);
    var c0 = Math.floor(off / 3) * 4, c1 = Math.ceil((off + len) / 3) * 4;
    var bin = atob(b64.slice(c0, c1));
    var skip = off % 3, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(skip + i);
    u = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    urlCache.set(ref, u);
    S.thumbs.created++;
    S.thumbs.decodeMs += performance.now() - t;
    return u;
  }
  S.decodeWholePack = function (name) { // for comparison only: eager decode of the full pack
    var t = performance.now();
    var bin = atob(packString(name));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes: bytes.length, ms: performance.now() - t };
  };

  // ---------- style ----------
  var TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
  var TERRAIN_ATTR = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen / AWS Terrain Tiles (SRTM, GMTED2010, ETOPO1, 鈥?</a>';
  var RASTERS = {
    esri: { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19,
      attribution: "Tiles 漏 Esri 鈥?Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" },
    osm: { tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19,
      attribution: '漏 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  };

  function buildStyle(basemap) {
    var style = {
      version: 8,
      // no "glyphs"/"sprite": nothing is fetched for the offline basemap
      sources: { ne: { type: "geojson", data: basemap, attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a>' } },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": theme.bg } },
        { id: "land", type: "fill", source: "ne", filter: ["==", ["get", "k"], "land"], paint: { "fill-color": theme.land } },
        { id: "coast", type: "line", source: "ne", filter: ["==", ["get", "k"], "land"], paint: { "line-color": theme.coast, "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.3, 8, 1.2] } },
        { id: "lake", type: "fill", source: "ne", filter: ["==", ["get", "k"], "lake"], paint: { "fill-color": theme.lake, "fill-outline-color": theme.coast } },
        { id: "river", type: "line", source: "ne", filter: ["==", ["get", "k"], "river"], minzoom: 2, paint: { "line-color": theme.river, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.4, 8, 1.5] } },
        { id: "border", type: "line", source: "ne", filter: ["==", ["get", "k"], "border"], paint: { "line-color": theme.border, "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 8, 1.2], "line-dasharray": [3, 2] } },
      ],
    };
    if (opt.raster && RASTERS[opt.raster]) {
      style.sources.raster = Object.assign({ type: "raster" }, RASTERS[opt.raster]);
      style.layers.push({ id: "raster", type: "raster", source: "raster" });
    }
    if (opt.terrain === "1" || opt.hillshade === "1") {
      // Two raster-dem sources with the same tiles: MapLibre's own 3D-terrain example does this;
      // sharing one source between terrain and hillshade gives seams/quality issues.
      var dem = { type: "raster-dem", tiles: [TERRARIUM], encoding: "terrarium", tileSize: 256, maxzoom: 15, attribution: TERRAIN_ATTR };
      style.sources.hillshadeDem = Object.assign({}, dem);
      style.sources.terrainDem = Object.assign({}, dem);
      style.layers.push({ id: "hillshade", type: "hillshade", source: "hillshadeDem", paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#3d3a35" } });
      if (opt.terrain === "1") style.terrain = { source: "terrainDem", exaggeration: +(opt.exag || 1.4) };
    }
    if (opt.globe === "1") style.projection = { type: "globe" };
    return style;
  }

  function start(maplibregl, topoFeature) {
    S.engine = { version: maplibregl.getVersion ? maplibregl.getVersion() : maplibregl.version };
    var c = document.createElement("canvas").getContext("webgl2");
    S.webgl2 = !!c;
    var project = window.__PHOTOWAY__ || readJsonScript("pw-data");
    var view = (opt.view || "10,30,1.3,0,0").split(",").map(Number);
    var el = document.getElementById("photoway");
    S.marks.mapCtorMs = performance.now();
    var map = (S.map = new maplibregl.Map({
      container: el,
      style: buildStyle(basemapGeojson(topoFeature)),
      center: [view[0], view[1]], zoom: view[2], pitch: view[3] || 0, bearing: view[4] || 0,
      maxPitch: 85,
      attributionControl: { compact: false },
      canvasContextAttributes: { preserveDrawingBuffer: true }, // only so the test can sample pixels
    }));
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
    map.on("error", function (e) {
      var msg = (e.error && (e.error.message || e.error.status)) || String(e);
      if (e.sourceId || e.tile) S.tileErrors.push((e.sourceId || "?") + ": " + msg);
      else S.errors.push("map error: " + msg);
    });
    map.on("sourcedata", function (e) {
      if (e.tile && e.sourceId) S.tiles[e.sourceId] = (S.tiles[e.sourceId] || 0) + 1;
    });
    map.on("load", function () {
      S.marks.loadMs = performance.now();
      if (project) addItems(maplibregl, map, project);
    });
    map.once("idle", function () { S.marks.firstIdleMs = performance.now(); });
    map.on("idle", function () { S.idle = true; S.idleCount = (S.idleCount || 0) + 1; });
    map.on("movestart", function () { S.idle = false; });

    S.pixels = function () {
      var src = map.getCanvas(), w = 120, h = 75;
      var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      var ctx = cv.getContext("2d");
      ctx.drawImage(src, 0, 0, w, h);
      var d = ctx.getImageData(0, 0, w, h).data, colors = new Set(), bgHex = theme.bg, nonBg = 0;
      var br = parseInt(bgHex.slice(1, 3), 16), bgG = parseInt(bgHex.slice(3, 5), 16), bb = parseInt(bgHex.slice(5, 7), 16);
      for (var i = 0; i < d.length; i += 4) {
        colors.add((d[i] >> 4) + "," + (d[i + 1] >> 4) + "," + (d[i + 2] >> 4));
        if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bb) > 24) nonBg++;
      }
      return { distinctColors: colors.size, nonBgFrac: +(nonBg / (w * h)).toFixed(3) };
    };
    S.elev = function (lng, lat) { return map.queryTerrainElevation ? map.queryTerrainElevation([lng, lat]) : null; };
    S.rendered = function (layers) {
      var out = {};
      layers.forEach(function (l) { try { out[l] = map.queryRenderedFeatures({ layers: [l] }).length; } catch (e) { out[l] = "err " + e.message; } });
      return out;
    };
    S.resolveRef = resolveRef;
    S.saveCopy = function () { return saveCopy(project); };
    var btn = document.getElementById("pw-save");
    if (btn) btn.addEventListener("click", function () { S.saveCopy(); });
    if (opt.autosave === "1") setTimeout(function () { S.autosaveResult = S.saveCopy(); }, 1500);
  }

  // ---------- items: cluster circles + DOM thumbnail markers for in-view leaves ----------
  function addItems(maplibregl, map, project) {
    var fc = { type: "FeatureCollection", features: project.items.map(function (it) {
      return { type: "Feature", properties: { id: it.id }, geometry: { type: "Point", coordinates: [it.lon, it.lat] } };
    }) };
    map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: project.items.map(function (it) { return [it.lon, it.lat]; }) } } });
    map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": theme.route, "line-width": 2.5, "line-opacity": 0.85 } });
    map.addSource("items", { type: "geojson", data: fc, cluster: true, clusterRadius: 48, clusterMaxZoom: 12 });
    map.addLayer({ id: "clusters", type: "circle", source: "items", filter: ["has", "point_count"], paint: {
      "circle-color": theme.route, "circle-opacity": 0.8, "circle-stroke-color": "#fff", "circle-stroke-width": 2,
      "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 12, 100, 22, 1000, 32] } });
    map.addLayer({ id: "leaves", type: "circle", source: "items", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": 4, "circle-color": theme.route } });

    var markers = new Map(), MAX = 150;
    function refresh() {
      var feats = map.queryRenderedFeatures({ layers: ["leaves"] });
      var want = new Set();
      for (var i = 0; i < feats.length && want.size < MAX; i++) want.add(feats[i].properties.id);
      markers.forEach(function (m, id) { if (!want.has(id)) { m.remove(); markers.delete(id); } });
      want.forEach(function (id) {
        if (markers.has(id)) return;
        var it = project.items[id];
        var div = document.createElement("div");
        div.className = "pw-thumb";
        var img = document.createElement("img");
        img.alt = it.name;
        img.decoding = "async";
        img.src = resolveRef(it.thumb);
        div.appendChild(img);
        markers.set(id, new maplibregl.Marker({ element: div }).setLngLat([it.lon, it.lat]).addTo(map));
      });
      S.thumbs.markers = markers.size;
    }
    map.on("idle", refresh);
    S.thumbStats = function () {
      var imgs = document.querySelectorAll(".pw-thumb img"), ok = 0;
      imgs.forEach(function (im) { if (im.complete && im.naturalWidth > 0) ok++; });
      return { markers: markers.size, imgs: imgs.length, imgsDecoded: ok, blobUrls: S.thumbs.created, decodeMs: +S.thumbs.decodeMs.toFixed(1) };
    };
  }

  // ---------- "Save a copy": re-serialize this document with edited #pw-data ----------
  function escapeJsonForScript(s) {
    return s.replace(/</g, "\\u003c").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");
  }
  function saveCopy(project) {
    var t = performance.now();
    var p = JSON.parse(JSON.stringify(project));
    p.title = p.title + " (copy)";
    p.items[0].lat += 0.01; p.items[0].lon += 0.01;
    p.items[0].flags = (p.items[0].flags || []).concat(["corrected"]);
    var root = document.documentElement.cloneNode(true);
    var mount = root.querySelector("#photoway");
    while (mount.firstChild) mount.removeChild(mount.firstChild); // drop MapLibre canvas, controls, markers
    mount.removeAttribute("class");
    root.querySelector("#pw-data").textContent = escapeJsonForScript(JSON.stringify(p));
    var html = "<!doctype html>\n" + root.outerHTML;
    var url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    var a = document.createElement("a");
    a.href = url; a.download = "photoway-copy.html";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return { bytes: html.length, ms: +(performance.now() - t).toFixed(1) };
  }

  window.SpikeApp = { start: start };
})();
