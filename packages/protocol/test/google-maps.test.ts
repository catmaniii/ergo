// 谷歌地图插件（446）在协议包里的：地图页报底图的接口拼得出、拆得回，请求体的 schema；设置里谷歌地图那一块的数据认得出。
import { describe, expect, it } from "vitest";
import { checkHttpBody, GOOGLE_MAPS_SKUS, HTTP_PATHS, isGoogleMapsSourcePanel, MapBasemapEventBody, parseHttpPath } from "../src/index.ts";

describe("谷歌地图插件的协议", () => {
  it("地图页报底图的事：POST /api/map/basemap，拆成 map_basemap；多一截的不认", () => {
    expect(HTTP_PATHS.mapBasemap).toBe("/api/map/basemap");
    expect(parseHttpPath(HTTP_PATHS.mapBasemap)).toEqual({ route: "map_basemap" });
    expect(parseHttpPath("/api/map/basemap/google")).toBeUndefined();
  });

  it("请求体：编号和两种事之一；别的不收", () => {
    expect(checkHttpBody(MapBasemapEventBody, { provider: "google", event: "loaded" }).ok).toBe(true);
    expect(checkHttpBody(MapBasemapEventBody, { provider: "google", event: "auth_failed" }).ok).toBe(true);
    expect(checkHttpBody(MapBasemapEventBody, { provider: "google", event: "zoomed" }).ok).toBe(false);
    expect(checkHttpBody(MapBasemapEventBody, { provider: "", event: "loaded" }).ok).toBe(false);
    expect(checkHttpBody(MapBasemapEventBody, { event: "loaded" }).ok).toBe(false);
  });

  it("设置里谷歌地图那一块：kind、两个 Key 填没填、用量、超了的几项都在才认", () => {
    const counts = Object.fromEntries(GOOGLE_MAPS_SKUS.map((s) => [s, 0]));
    const panel = { kind: "google-maps", browserKey: true, serverKey: false, usage: { month: "2026-11", counts, limits: counts }, allowOverage: false, over: [] };
    expect(isGoogleMapsSourcePanel(panel)).toBe(true);
    expect(isGoogleMapsSourcePanel({ ...panel, kind: "amap" })).toBe(false);
    expect(isGoogleMapsSourcePanel({ ...panel, over: undefined })).toBe(false);
    expect(isGoogleMapsSourcePanel(null)).toBe(false);
  });
});
