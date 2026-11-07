// 地图（429）的坐标转换和地址：WGS-84 ↔ GCJ-02（大陆内才转）、在不在大陆、瓦片地址、地图页的定位、/api/map/config。
import { describe, expect, it } from "vitest";
import {
  AMAP_SERVICE_PREFIX,
  distanceMeters,
  gcjToWgs,
  HTTP_PATHS,
  inMainlandChina,
  mapFocusItem,
  mapTilePath,
  parseHttpPath,
  parseMapFocusItem,
  parseMapTilePath,
  wgsToGcj,
} from "../src/index.ts";

const at = (lat: number, lon: number) => ({ lat, lon });

describe("在不在中国大陆", () => {
  it("大陆的城市在里面（含海南、新疆、西藏、东北、紧挨香港澳门的深圳珠海）", () => {
    for (const [name, lat, lon] of [
      ["杭州", 30.27, 120.15],
      ["北京", 39.91, 116.4],
      ["上海", 31.23, 121.47],
      ["舟山", 30.0, 122.2],
      ["青岛", 36.07, 120.38],
      ["大连", 38.9, 121.6],
      ["广州", 23.13, 113.26],
      ["深圳福田", 22.54, 114.06],
      ["深圳蛇口", 22.48, 113.91],
      ["珠海拱北", 22.23, 113.55],
      ["横琴", 22.12, 113.52],
      ["厦门", 24.48, 118.09],
      ["海口", 20.04, 110.32],
      ["南宁", 22.82, 108.37],
      ["昆明", 25.04, 102.7],
      ["拉萨", 29.65, 91.1],
      ["乌鲁木齐", 43.8, 87.6],
      ["喀什", 39.47, 75.99],
      ["哈尔滨", 45.75, 126.6],
      ["海拉尔", 49.2, 119.7],
      ["抚远", 48.36, 134.29],
    ] as const) {
      expect(inMainlandChina(at(lat, lon)), name).toBe(true);
    }
  });

  it("香港、澳门、台湾和邻国在外面", () => {
    for (const [name, lat, lon] of [
      ["香港中环", 22.28, 114.16],
      ["尖沙咀", 22.3, 114.17],
      ["上水", 22.5, 114.13],
      ["屯门", 22.39, 113.97],
      ["香港机场", 22.31, 113.92],
      ["澳门半岛", 22.19, 113.55],
      ["氹仔", 22.155, 113.56],
      ["台北", 25.03, 121.56],
      ["高雄", 22.63, 120.3],
      ["新加坡", 1.35, 103.82],
      ["首尔", 37.57, 126.98],
      ["平壤", 39.03, 125.75],
      ["东京", 35.68, 139.69],
      ["乌兰巴托", 47.9, 106.9],
      ["河内", 21.03, 105.85],
      ["加德满都", 27.7, 85.32],
      ["廷布", 27.47, 89.64],
      ["阿拉木图", 43.25, 76.9],
      ["符拉迪沃斯托克", 43.12, 131.89],
      ["哈巴罗夫斯克", 48.48, 135.07],
      ["伦敦", 51.5, -0.12],
    ] as const) {
      expect(inMainlandChina(at(lat, lon)), name).toBe(false);
    }
  });

  it("不是数的不算在里面", () => {
    expect(inMainlandChina(at(Number.NaN, 120))).toBe(false);
    expect(inMainlandChina(at(30, Number.POSITIVE_INFINITY))).toBe(false);
  });
});

describe("WGS-84 和 GCJ-02 互转", () => {
  // 高德坐标转换接口文档的示例点（116.481499,39.990475，coordsys=gps），高德交回的 GCJ-02 是 116.487585177952,39.991754014757
  // （这个转换结果是常被引用的样例值，文档页现在没写结果）。公开算法和高德的结果差几厘米
  const amapGps = at(39.990475, 116.481499);
  const amapGcj = at(39.991754014757, 116.487585177952);

  it("已知点：和高德的转换结果差不到 1 米", () => {
    expect(distanceMeters(wgsToGcj(amapGps), amapGcj)).toBeLessThan(1);
  });

  it("已知点反算：高德交回的点转回 WGS-84，和原来的差不到 1 米", () => {
    expect(distanceMeters(gcjToWgs(amapGcj), amapGps)).toBeLessThan(1);
  });

  it("大陆里来回转一圈差不到 1 厘米", () => {
    for (const p of [at(30.2741, 120.1551), at(22.5431, 114.0579), at(43.8256, 87.6168), at(29.652, 91.172), at(45.75, 126.65), at(20.04, 110.32)]) {
      expect(distanceMeters(gcjToWgs(wgsToGcj(p)), p)).toBeLessThan(0.01);
    }
  });

  it("大陆里的偏移在几百米上下（混用就会差这么多）", () => {
    for (const p of [at(30.2741, 120.1551), at(39.9042, 116.4074), at(31.2304, 121.4737)]) {
      const d = distanceMeters(wgsToGcj(p), p);
      expect(d).toBeGreaterThan(100);
      expect(d).toBeLessThan(800);
    }
  });

  it("大陆外（新加坡、香港、台北）原样交回", () => {
    for (const p of [at(1.2903, 103.852), at(22.2819, 114.1586), at(25.033, 121.5654)]) {
      expect(wgsToGcj(p)).toEqual(p);
      expect(gcjToWgs(p)).toEqual(p);
    }
  });
});

describe("两点距离", () => {
  it("赤道上 1 度经度约 111.2 公里", () => {
    expect(distanceMeters(at(0, 0), at(0, 1))).toBeCloseTo(111_195, -1);
    expect(distanceMeters(at(30, 120), at(30, 120))).toBe(0);
  });
});

describe("瓦片地址", () => {
  it("拼出来拆得回去，可以带 .png", () => {
    expect(mapTilePath("osm", 12, 3428, 1678)).toBe("/tiles/osm/12/3428/1678");
    expect(parseMapTilePath("/tiles/osm/12/3428/1678")).toEqual({ source: "osm", z: 12, x: 3428, y: 1678 });
    expect(parseMapTilePath("/tiles/osm/0/0/0.png")).toEqual({ source: "osm", z: 0, x: 0, y: 0 });
  });

  it("不认得的源、超出级别或范围、多出来的段都不算", () => {
    expect(parseMapTilePath("/tiles/amap/1/0/0")).toBeUndefined();
    expect(parseMapTilePath("/tiles/osm/20/0/0")).toBeUndefined();
    expect(parseMapTilePath("/tiles/osm/2/4/0")).toBeUndefined();
    expect(parseMapTilePath("/tiles/osm/2/0/4")).toBeUndefined();
    expect(parseMapTilePath("/tiles/osm/2/0/0/1")).toBeUndefined();
    expect(parseMapTilePath("/tiles/osm/2/-1/0")).toBeUndefined();
    expect(parseMapTilePath("/tiles/osm/2/0/0.jpg")).toBeUndefined();
    expect(parseMapTilePath("/tiles/osm/../../x")).toBeUndefined();
  });

  it("高德安全密钥代理的前缀是高德定的", () => {
    expect(AMAP_SERVICE_PREFIX).toBe("/_AMapService");
  });
});

describe("地图页的定位", () => {
  it("纬度,经度[,级别] 拼出来拆得回去", () => {
    expect(mapFocusItem({ lat: 30.2741234, lon: 120.1551, zoom: 14 })).toBe("30.274123,120.1551,14");
    expect(parseMapFocusItem("30.274123,120.1551,14")).toEqual({ lat: 30.274123, lon: 120.1551, zoom: 14 });
    expect(parseMapFocusItem("1.29,103.85")).toEqual({ lat: 1.29, lon: 103.85 });
  });

  it("不是这个样子、超出范围的不认", () => {
    for (const item of [undefined, "", "30", "30,abc", "91,0", "0,181", "30,120,99", "30,120,14,1", "30,,120"]) expect(parseMapFocusItem(item), String(item)).toBeUndefined();
  });
});

describe("GET /api/map/config", () => {
  it("拼出来拆得回去", () => {
    expect(HTTP_PATHS.mapConfig).toBe("/api/map/config");
    expect(parseHttpPath(HTTP_PATHS.mapConfig)).toEqual({ route: "map_config" });
    expect(parseHttpPath("/api/map")).toBeUndefined();
    expect(parseHttpPath("/api/map/config/x")).toBeUndefined();
  });
});
