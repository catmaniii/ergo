# ADR-0057 谷歌地图做成插件，接进地图服务插槽

状态：已定（446，用户 2026-11-08："海外能集成谷歌地图吗？如果可以的话，做成插件""国内和国外都可以在可用的地图之间切换"）。建在 ADR-0056 的插槽上，不改"自动"时国内高德、国外 OpenStreetMap 的挑法——只是大陆外多了一家优先级更高的。

**451 修订**（[ADR-0059](0059-map-one-current-map.md)）：谷歌多一项静态地图（Maps Static API，计费项 `staticMaps`）；大陆外没填谷歌、谷歌停用或超额时退回高德（高德也没有才 OpenStreetMap）。

**453 修订**（[ADR-0059 的 453 修订](0059-map-one-current-map.md#453-修订足迹和二狗画的点线只在本机画高德谷歌只出底图)）：谷歌的脚本关进 `<iframe sandbox="allow-scripts">`（`/map-frame.html`），框里只收设置和视野、只出底图，点和线画在地图页自己那一层；静态图只要光底图。原来在页面里加载脚本的 `loader.ts` 去掉了。

## 背景

- 大陆外现在只有 OpenStreetMap：免费，但没有公交、没有实时路况，店名门牌不全。Google Maps Platform 在新加坡这类地方数据好（调研 2026-11-07-maps 3.1），每月每个计费项有免费量，但**必须开结算账户**，超了按量收费。
- 谷歌的规矩和高德类似：查来的只能画在谷歌地图上、不许缓存（place ID 可以长期存，坐标最多 30 天）、要写明来自 Google Maps。
- 谷歌在中国大陆：街道图是 GCJ-02（和高德一样）；设备在大陆连不上谷歌，电脑的出口（新加坡）能连。

## 决定

1. **独立插件 `google-maps`**（守护进程 `packages/daemon/src/google-maps/`、网页 `packages/web/src/plugins/google-maps/`），`needs: [MAP_PROVIDERS]`，在 `setup` 里经 `ctx.effect` 登记一家 `google`：`regions: ["abroad"]`、`manualRegions: ["abroad", "mainland"]`、`priority: 50`、`ownBasemapOnly: true`。停用、移除时插槽替它撤掉，大陆外退回 OpenStreetMap。内核、组合根都不认得它。秘书工具不新增。
2. **两个 Key，存密钥区**（数据源 `google-maps`，`ownTools` 的按需查开关）：浏览器用的（Maps JavaScript API，要进页面，靠 Google Cloud 的"网站限制"守）、服务端用的（Places API (New)、Routes API、Geocoding API，不进页面，靠"IP 限制"守）。服务端 Key 先测再存：三个 API 各问一次固定的地方，哪个没开、哪个限制不让写清楚。**浏览器用的只看写法就存**：谷歌只让网页测它（网站限制按浏览器带的来源认，守护进程替它测不算数），真不对时地图页收到 `gm_authFailure`，报给守护进程记下（`basemap()` 不再交 Key），重新填才清掉。
3. **地图页报底图的事**：新接口 `POST /api/map/basemap { provider, event: "loaded" | "auth_failed" }`（地图插件的，转给登记的那一家：`MapProvider.basemapEvent`）。谷歌按"一次地图加载"计费，只有页面知道建了几张，守护进程据此数 Dynamic Maps；Key 被拒也只有页面知道。网页那边引擎多了 `onFailed`（`model/map.ts` 的 `MapEngineEvents`）：建好以后那一家又不能用了，地图页当成"这一页加载失败"（退回 OpenStreetMap、切换里标"连不上"、手动选的退回"自动"），和准备时抛错一样。
4. **查询只要用到的字段**（字段掩码决定收费档）：地点 `places.id,displayName,formattedAddress,location,primaryTypeDisplayName`（Text Search Pro / Nearby Search Pro）；"附近说了找什么"用 Text Search 加圈的 `locationBias`、`rankPreference: DISTANCE`（Nearby Search 不收关键字），回来的自己按距离排、去掉圈外的；路线 `computeRoutes` 要折线，开车 `TRAFFIC_AWARE`（Compute Routes Pro），步行、公交 Essentials；分段路况（`speedReadingIntervals`）是 Enterprise 档，不要。地址 ↔ 位置用 Geocoding API。大陆里的点发出去前转 GCJ-02、回来的转回 WGS-84。结果不存。
5. **用量按计费项数，超了先停用**：每月 dynamicMaps、textSearch、nearbySearch、geocoding、routesEssentials、routesPro 各数各的（插件自己的存储 `google-maps/usage.json`），八成体检提醒；哪一项到了免费量且用户没放开：底图那一项超了 `basemap()` 不交 Key，查询的哪一项超了 `lookup()` 交回原因——都自动退回 OpenStreetMap（插槽管）、说一句。设置里"超了还接着用"放开（`google-maps/settings.json`，不是密钥）。真正挡扣钱的是 Google Cloud 里的每日上限，手册写了步骤。
6. **加载用官方的动态库导入加载法、写死版本**（`v=3.65`，谷歌删了旧版会自动给默认那一档，升级时改一个数）。一页只加载一次；换了 Key 要刷新页面。加载不上（设备在大陆、断网）抛"连不上谷歌"，插槽的规矩接着管。点放在 `OverlayView` 的 `overlayMouseTarget` 层里（不用已废弃的 `Marker`，也不用要 Map ID 的 `AdvancedMarkerElement`），深色用 `colorScheme`（只能建地图时定，换外观时重建一张）。

## 后果

- 用户要自己在 Google Cloud 建项目、开结算、建两个 Key、加限制、设预算提醒和每日上限（手册 `docs/user-guide/map.md`「国外用谷歌地图」，中英）。二狗不碰付款信息。
- 浏览器用的 Key 填错了要到地图页第一次用上谷歌底图时才知道（这是谷歌的设计决定的）。
- 二狗数的次数和谷歌账单不一定对得上（谷歌按太平洋时间算月份），以控制台为准。
- 体检里谷歌的用量在"地图"那一块（地图插件替各家登记），不在谷歌地图插件那一块。
- 演示页当作填好了谷歌的 Key（假谷歌、编的占位瓦片），新加坡"自动"是谷歌；429、442、445 的页面测试改成停用谷歌地图插件再测（照原样），谷歌在的样子另写几条。
- 没用真 Key 调过谷歌：接口的样子照文档样例和字段说明，第一次真用时要看一眼。
