/** Every user-visible English string lives here, so localisation stays possible later. */
export const T = {
  appName: "Photo Way",
  loadError: "This file does not contain any trip data.",
  noItems: "This trip has no photos or videos yet.",
  noWebgl: "This browser cannot show the map (WebGL 2 is required). The timeline still works.",

  stats: {
    items: (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`,
    days: (n: number) => `${n} ${n === 1 ? "day" : "days"}`,
    shown: (n: number, total: number) => `${n.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} shown`,
    outliers: (n: number) => `${n} GPS ${n === 1 ? "outlier" : "outliers"}`,
    elevation: (gain: number, loss: number) => `↑ ${gain.toLocaleString("en-US")} m ↓ ${loss.toLocaleString("en-US")} m`,
  },

  toolbar: {
    filters: "Filters",
    layers: "Map",
    theme: "Theme",
    menu: "More",
    fit: "Fit all",
    globe: "Globe",
    flat: "Flat map",
    zoomHint: "Zoom in to see photos",
  },

  filters: {
    title: "Show on map",
    type: "Type",
    all: "All",
    photo: "Photos",
    video: "Videos",
    live: "Live",
    route: "Route",
    outliers: "Hide GPS outliers",
    outliersHint: "Hides items that would need more than {speed} km/h to reach. They stay in the timeline.",
    order: "Trip order",
    timeColor: "Color by time",
    timeColorHint: "The route goes from light at the first photo to dark at the last.",
    numbers: "Number the stops",
    numbersHint: "Numbers follow capture time across the whole trip.",
    highlight: "Highlight on hover",
    highlightHint: "Pointing at a photo lights up its part of the route. A chosen day keeps the other days faint.",
  },

  play: {
    play: "Play the trip",
    pause: "Pause",
    speed: (x: number) => `Playback speed ${x}x (click to change)`,
  },

  legend: {
    label: "Trip order, first to last photo",
  },

  map: {
    title: "Map style",
    offline: "Offline world",
    satellite: "Satellite",
    satelliteLabels: "Satellite + labels",
    topo: "Topographic",
    osm: "Street map",
    terrain: "3D terrain",
    offlineNote: "Works without internet",
    onlineNote: "Needs internet",
    terrainOffline: "3D terrain needs an internet connection",
    exaggeration: "Terrain exaggeration",
    onlineFailed: "Online maps could not be loaded, showing the offline map.",
    offlineHint:"Offline map: connect to the internet for detailed maps.",
    projection: "Projection",
    attribution: {
      naturalEarth: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>',
      esri: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      esriLabels: "Labels &copy; Esri",
      osm: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      opentopo:
        'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, <a href="https://viewfinderpanoramas.org" target="_blank" rel="noopener">SRTM</a> | Map style &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC-BY-SA</a>)',
      terrain:
        '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Terrain: Mapzen / AWS Terrain Tiles</a>',
    },
  },

  theme: {
    title: "Theme",
    auto: "Auto",
    light: "Light",
    dark: "Dark",
    dusk: "Dusk",
    paper: "Paper",
    forest: "Forest",
  },

  menu: {
    exportCorrections: "Export corrections",
    exportCorrectionsHint: "Download your location fixes and hidden items as JSON",
    saveCopy: "Save a copy",
    saveCopyHint: "Download this page with your edits built in",
    saveCopyKeepHidden: "Keep hidden items in the copy",
    saveCopyGo: "Download copy",
    saveCopyBundle: "Saving a copy needs the single-file version of this page.",
    resetAll: "Discard all edits",
    resetConfirm: "Discard every location fix and hidden item stored in this browser?",
    edits: (fixes: number, hidden: number) => {
      const parts: string[] = [];
      if (fixes) parts.push(`${fixes} ${fixes === 1 ? "location fix" : "location fixes"}`);
      if (hidden) parts.push(`${hidden} hidden`);
      return parts.length ? parts.join(", ") : "No edits yet";
    },
    storageOff: "Browser storage is unavailable, so edits will not survive a reload. Use Export corrections or Save a copy.",
    privacy: "Edits are stored in this browser and can be read by other local pages.",
  },

  days: {
    all: "All days",
    allShort: "All",
    none: "No date",
    prev: "Previous day",
    next: "Next day",
    list: "Choose a day",
    toggle: "Show or hide every item of this day",
    count: (n: number) => `${n} ${n === 1 ? "item" : "items"}`,
  },

  timeline: {
    label: "Timeline",
    empty: "Nothing matches the current filters.",
    hide: "Show on map",
    video: "Video",
    live: "Live",
    suspect: "Suspect GPS position",
    fixed: "Location corrected",
    hint: "Click to locate, double-click to open",
  },

  card: {
    open: "Open",
    reset: "Reset position",
    hide: "Hide",
    show: "Show",
    close: "Close",
    dragHint: "Drag the pin to correct its position",
    corrected: "Corrected",
    suspect: "Suspect GPS",
    hiddenTag: "Hidden",
    noTime: "No capture time",
  },

  modal: {
    close: "Close",
    prev: "Previous",
    next: "Next",
    showOnMap: "Show on map",
    counter: (i: number, n: number) => `${i} / ${n}`,
    videoMissing: "The video file is not part of this export. Showing its preview image.",
    liveHold: "Play motion",
    thumbOnly: "Preview image only - full size is not included in this export.",
    loading: "Loading",
  },

  cluster: { zoom: "Zoom in" },
  start: "Start",
  end: "End",
};

export type Strings = typeof T;
