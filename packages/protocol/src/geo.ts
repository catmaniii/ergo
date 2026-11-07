// 地图的坐标（429 地图插件）：二狗里一律存、传 WGS-84（手机系统定位、照片 EXIF、OpenStreetMap 都是它），
// 只有跟高德（GCJ-02）来回时才转——画到高德地图上、交给高德查之前转成 GCJ-02，高德交回来的转回 WGS-84。
// - 只转中国大陆范围内的点：香港、澳门、台湾和国外不偏移（GCJ-02 在那里就等于 WGS-84）；
// - WGS-84 → GCJ-02 用公开的那套算法（克拉索夫斯基椭球的参数），和高德坐标转换接口的结果差几厘米；
// - GCJ-02 → WGS-84 官方不给，这里迭代反算：每次用正算的偏移修正，几次就收敛到厘米以下；
// - 大陆范围是一个粗略的外轮廓（几十个点，边境上差几十公里），只用来判断"该不该转、该用哪种底图"，**不是边界线**：
//   香港、澳门、台湾按实际单独划出去了（深圳河、拱北、台湾海峡），陆地边境只求大致不错，边境口岸附近可能判错一边。
// 都是纯函数，网页和守护进程共用（网页画高德地图、432 守护进程查高德都用它）。

/** 一个点：纬度、经度（度） */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/**
 * 中国大陆的粗略外轮廓（[经度, 纬度]，首尾不重复）：从漠河往西沿北边，经西边、西南、南边的陆地边境，
 * 再沿海岸外的海面绕回东北。澳门、香港、台湾（连同澎湖）在外面；金门、马祖离大陆太近，分不开，算在里面。
 */
const MAINLAND: readonly (readonly [number, number])[] = [
  // 东北：漠河，额尔古纳河往西南到满洲里一带
  [121.5, 53.4], [120.0, 52.7], [119.1, 50.4], [117.8, 49.6], [116.7, 49.9],
  // 和蒙古：呼伦贝尔往南绕一个弯，再一路往西
  [115.5, 48.1], [117.4, 47.7], [118.6, 48.0], [119.8, 47.2], [119.9, 46.6], [117.4, 46.5], [116.0, 45.7], [113.6, 44.7], [111.9, 43.7],
  [110.4, 42.7], [107.5, 42.4], [105.0, 41.6], [101.8, 42.5], [96.4, 42.7], [95.4, 44.3], [93.5, 45.0], [90.9, 45.3], [90.7, 47.0],
  [88.0, 48.6], [87.8, 49.2],
  // 哈萨克斯坦、吉尔吉斯斯坦、塔吉克斯坦
  [86.8, 49.1], [85.6, 48.1], [85.7, 47.0], [83.0, 47.2], [82.4, 45.5], [80.1, 44.9], [80.2, 42.2], [78.0, 41.1], [76.5, 40.4],
  [75.6, 40.6], [73.5, 39.4], [73.6, 38.5], [74.9, 37.4],
  // 帕米尔、喀喇昆仑往东南
  [75.5, 36.9], [77.8, 35.5], [78.3, 34.6], [79.3, 32.6], [78.7, 31.5], [80.3, 30.4],
  // 尼泊尔、不丹北边，往东到和缅甸交界
  [81.6, 30.4], [83.5, 29.3], [85.5, 28.3], [88.0, 27.9], [88.9, 27.3], [89.6, 28.2], [91.6, 27.8], [92.0, 27.8], [94.0, 28.6],
  [95.2, 29.1], [96.3, 29.2], [97.3, 28.3],
  // 缅甸、老挝、越南
  [98.5, 27.6], [98.7, 26.0], [97.6, 24.8], [97.5, 23.9], [98.9, 23.2], [99.5, 22.1], [100.2, 21.5], [101.1, 21.7], [101.75, 21.15],
  [102.15, 22.4], [102.5, 22.8], [103.9, 22.5], [105.3, 23.35], [106.7, 22.9], [106.75, 22.0], [107.4, 21.65], [108.0, 21.5],
  // 北部湾、海南南边，往东北回到珠江口
  [108.2, 21.0], [108.3, 19.0], [108.5, 17.8], [110.0, 17.8], [111.4, 19.0], [112.0, 20.5], [113.4, 21.9],
  // 澳门（东边是澳门，西边是珠海、横琴）
  [113.548, 22.1], [113.545, 22.17], [113.525, 22.2], [113.545, 22.215], [113.6, 22.235],
  // 香港（南边是香港，北边是深圳：深圳湾、深圳河、沙头角、大鹏湾）
  [113.65, 22.27], [113.8, 22.4], [113.88, 22.43], [113.95, 22.48], [114.03, 22.505], [114.15, 22.535], [114.23, 22.555], [114.35, 22.58],
  [114.45, 22.5], [114.55, 22.35], [115.0, 22.2],
  // 台湾海峡（东边是台湾、澎湖）
  [116.8, 22.5], [118.5, 23.6], [119.8, 25.0], [120.6, 26.4], [122.5, 27.5],
  // 东海、黄海（东边是韩国、朝鲜的岛）
  [123.5, 29.0], [123.8, 32.0], [123.6, 37.5], [124.15, 39.75],
  // 鸭绿江、图们江
  [124.4, 40.05], [125.3, 40.6], [126.6, 41.7], [128.1, 41.9], [129.0, 42.3], [129.9, 42.95], [130.4, 42.6], [130.65, 42.42],
  // 俄罗斯：乌苏里江、黑龙江
  [131.0, 42.9], [131.2, 43.5], [131.3, 44.4], [131.0, 44.9], [133.1, 45.1], [134.0, 47.3], [134.75, 48.45], [133.0, 48.15],
  [130.9, 48.85], [128.0, 49.6], [127.5, 50.3], [126.7, 51.75], [125.7, 52.9], [123.5, 53.55],
];

/** 外轮廓的外接框：框外的直接判"不在"（省得每次走一遍多边形） */
const BOUNDS = MAINLAND.reduce(
  (b, [lon, lat]) => ({ minLon: Math.min(b.minLon, lon), maxLon: Math.max(b.maxLon, lon), minLat: Math.min(b.minLat, lat), maxLat: Math.max(b.maxLat, lat) }),
  { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity },
);

/** 这个点在不在中国大陆（粗略的外轮廓，见文件开头）：GCJ-02 只在这里面偏移，国内底图也只在这里面用 */
export function inMainlandChina(p: LatLon): boolean {
  const { lat, lon } = p;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lon < BOUNDS.minLon || lon > BOUNDS.maxLon || lat < BOUNDS.minLat || lat > BOUNDS.maxLat) return false;
  // 射线法：往东发一条射线，数穿过几条边
  let inside = false;
  for (let i = 0, j = MAINLAND.length - 1; i < MAINLAND.length; j = i++) {
    const [xi, yi] = MAINLAND[i]!;
    const [xj, yj] = MAINLAND[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 克拉索夫斯基椭球的长半轴、偏心率的平方（GCJ-02 的算法用它） */
const KRASOVSKY_A = 6378245.0;
const KRASOVSKY_EE = 0.00669342162296594323;

function offsetLat(x: number, y: number): number {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}

function offsetLon(x: number, y: number): number {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}

/** 正算的偏移（不看在不在大陆）：GCJ-02 = WGS-84 + 它 */
function gcjDelta(lat: number, lon: number): { dLat: number; dLon: number } {
  const rad = (lat / 180) * Math.PI;
  const sin = Math.sin(rad);
  const magic = 1 - KRASOVSKY_EE * sin * sin;
  const sqrtMagic = Math.sqrt(magic);
  const dLat = (offsetLat(lon - 105, lat - 35) * 180) / (((KRASOVSKY_A * (1 - KRASOVSKY_EE)) / (magic * sqrtMagic)) * Math.PI);
  const dLon = (offsetLon(lon - 105, lat - 35) * 180) / ((KRASOVSKY_A / sqrtMagic) * Math.cos(rad) * Math.PI);
  return { dLat, dLon };
}

/** WGS-84 → GCJ-02（大陆外原样交回）：画到高德地图上、交给高德查之前用 */
export function wgsToGcj(p: LatLon): LatLon {
  if (!inMainlandChina(p)) return { lat: p.lat, lon: p.lon };
  const { dLat, dLon } = gcjDelta(p.lat, p.lon);
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}

/** 反算迭代到多准停（度）：1e-9 度约 0.1 毫米 */
const INVERSE_EPSILON = 1e-9;
const INVERSE_MAX_STEPS = 30;

/**
 * GCJ-02 → WGS-84（高德交回来的点用；大陆外原样交回）：从 GCJ-02 那个点出发，正算一次、按差值修正，重复到差值小于 1e-9 度
 * （一般 3～6 次，误差在厘米以下）。在不在大陆按 GCJ-02 的点判（两者只差几百米，只在边境上可能判得不一样）
 */
export function gcjToWgs(p: LatLon): LatLon {
  if (!inMainlandChina(p)) return { lat: p.lat, lon: p.lon };
  let lat = p.lat;
  let lon = p.lon;
  for (let i = 0; i < INVERSE_MAX_STEPS; i++) {
    const { dLat, dLon } = gcjDelta(lat, lon);
    const errLat = lat + dLat - p.lat;
    const errLon = lon + dLon - p.lon;
    lat -= errLat;
    lon -= errLon;
    if (Math.abs(errLat) < INVERSE_EPSILON && Math.abs(errLon) < INVERSE_EPSILON) break;
  }
  return { lat, lon };
}

/** 地球平均半径（米），算两点距离用 */
const EARTH_RADIUS_M = 6371008.8;

/** 两点之间的大圆距离（米，球面近似，几公里内误差在千分之几） */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
