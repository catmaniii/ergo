// 谷歌的折线编码（Encoded Polyline Algorithm Format，developers.google.com/maps/documentation/utilities/polylinealgorithm）：
// Routes API 回的 polyline.encodedPolyline 是这种写法（默认精度 5 位小数）。纯函数：解出来的是谷歌的坐标
// （大陆里是 GCJ-02，转不转由调的人管）。编码那一半只给测试的假谷歌用。
import type { LatLon } from "@ergo/protocol";

/** 解一段编码的折线（坏的、截断的到哪算哪） */
export function decodePolyline(text: string, precision = 5): LatLon[] {
  const factor = 10 ** precision;
  const out: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number | undefined => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (index >= text.length) return undefined;
      b = text.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && shift < 35);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < text.length) {
    const dLat = next();
    const dLon = next();
    if (dLat === undefined || dLon === undefined) break;
    lat += dLat;
    lon += dLon;
    out.push({ lat: lat / factor, lon: lon / factor });
  }
  return out;
}

/** 编一段折线（测试的假谷歌用） */
export function encodePolyline(points: readonly LatLon[], precision = 5): string {
  const factor = 10 ** precision;
  let out = "";
  let lastLat = 0;
  let lastLon = 0;
  const put = (delta: number) => {
    let v = delta < 0 ? ~(delta << 1) : delta << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lon = Math.round(p.lon * factor);
    put(lat - lastLat);
    put(lon - lastLon);
    lastLat = lat;
    lastLon = lon;
  }
  return out;
}
