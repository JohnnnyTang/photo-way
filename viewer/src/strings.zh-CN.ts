import { EN, type Strings } from "./strings";

const count = (n: number, unit: string) => `${n.toLocaleString("zh-CN")} ${unit}`;

/** Viewer catalog; Strings enforces matching keys and function parameters. */
export const T_ZH: Strings = {
  appName: "Photo Way",
  loadError: "此文件不包含旅程数据。",
  noItems: "此旅程还没有照片或视频。",
  noWebgl: "此浏览器无法显示地图（需要 WebGL 2），但仍可查看时间线。",
  stats: {
    items: (n) => count(n, "项"),
    days: (n) => count(n, "天"),
    shown: (n, total) => `显示 ${n.toLocaleString("zh-CN")} / ${total.toLocaleString("zh-CN")} 项`,
    outliers: (n) => `${count(n, "处")} GPS 异常点`,
    elevation: (gain, loss) => `↑ ${gain.toLocaleString("zh-CN")} 米 ↓ ${loss.toLocaleString("zh-CN")} 米`,
  },
  toolbar: {
    filters: "筛选", layers: "地图", theme: "主题", menu: "更多",
    fit: "显示全部", globe: "地球", flat: "平面地图", zoomHint: "放大以查看照片",
  },
  filters: {
    title: "在地图上显示", type: "类型", all: "全部", photo: "照片", video: "视频", live: "实况照片",
    route: "路线", outliers: "隐藏 GPS 异常点",
    outliersHint: "隐藏需要以超过 {speed} 公里/小时才能到达的项目。它们仍会保留在时间线中。",
    order: "旅程顺序", timeColor: "按时间着色",
    timeColorHint: "路线颜色从第一张照片的浅色逐渐变为最后一张的深色。",
    numbers: "为停靠点编号", numbersHint: "编号按照整段旅程的拍摄时间排列。",
    highlight: "悬停时高亮", highlightHint: "指向照片时高亮对应的路线。选中某一天后，其他日期的路线会变淡。",
  },
  play: { play: "播放旅程", pause: "暂停", speed: (x) => `播放速度 ${x} 倍（点击更改）` },
  legend: { label: "旅程顺序：从第一张到最后一张照片" },
  map: {
    title: "地图样式", offline: "离线世界地图", satellite: "卫星图",
    satelliteLabels: "带标注的卫星图", topo: "地形图", osm: "街道地图", terrain: "三维地形",
    offlineNote: "无需联网", onlineNote: "需要联网", terrainOffline: "三维地形需要网络连接",
    exaggeration: "地形夸张程度", onlineFailed: "无法加载在线地图，已显示离线地图。",
    offlineHint: "当前使用离线地图。联网后可查看更详细的地图。", projection: "投影方式",
    attribution: EN.map.attribution,
  },
  theme: {
    title: "主题", auto: "自动", light: "浅色", dark: "深色",
    dusk: "暮色", paper: "纸张", forest: "森林",
  },
  menu: {
    language: "语言 / Language",
    exportCorrections: "导出修正", exportCorrectionsHint: "将位置修正和隐藏项目下载为 JSON 文件",
    saveCopy: "保存副本", saveCopyHint: "下载包含当前编辑内容的页面",
    saveCopyKeepHidden: "在副本中保留隐藏项目", saveCopyGo: "下载副本",
    saveCopyBundle: "保存副本需要此页面的单文件版本。",
    resetAll: "放弃所有编辑", resetConfirm: "放弃此浏览器中保存的所有位置修正和隐藏项目？",
    edits: (fixes, hidden) => {
      const parts: string[] = [];
      if (fixes) parts.push(`${count(fixes, "处")}位置修正`);
      if (hidden) parts.push(`${count(hidden, "项")}已隐藏`);
      return parts.length ? parts.join("，") : "尚无编辑";
    },
    storageOff: "浏览器存储不可用，重新加载后编辑内容将丢失。请使用“导出修正”或“保存副本”。",
    privacy: "编辑内容保存在此浏览器中，其他本地页面可能读取这些内容。",
  },
  days: {
    all: "所有日期", allShort: "全部", none: "无日期", prev: "前一天", next: "后一天",
    list: "选择日期", toggle: "显示或隐藏这一天的所有项目", count: (n) => count(n, "项"),
  },
  timeline: {
    label: "时间线", empty: "当前筛选条件下没有项目。", hide: "在地图上显示",
    video: "视频", live: "实况照片", suspect: "可疑的 GPS 位置",
    fixed: "位置已修正", hint: "单击定位，双击打开",
  },
  card: {
    open: "打开", reset: "重置位置", hide: "隐藏", show: "显示", close: "关闭",
    dragHint: "拖动图钉以修正位置", corrected: "已修正", suspect: "可疑的 GPS 位置",
    hiddenTag: "已隐藏", noTime: "无拍摄时间",
  },
  modal: {
    close: "关闭", prev: "上一项", next: "下一项", showOnMap: "在地图上显示",
    counter: (i, n) => `${i} / ${n}`,
    videoMissing: "此导出文件不包含视频原文件，正在显示预览图。",
    liveHold: "播放动态照片", thumbOnly: "仅有预览图，此导出文件不包含完整尺寸的照片。",
    loading: "正在加载",
  },
  cluster: { zoom: "放大" },
  start: "起点", end: "终点",
};
