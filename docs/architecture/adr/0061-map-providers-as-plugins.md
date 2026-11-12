# ADR-0061 OpenStreetMap、高德地图、谷歌地图各是一个插件，地图插件只管地图本身

状态：已定（455，用户 2026-11-09："open stream map，高德地图，谷歌地图这三个是不是可以做三个插件？"）。建在 [ADR-0056](0056-map-provider-slot.md) 的插槽上；"自动"的挑法、当前地图（[ADR-0059](0059-map-one-current-map.md)）、本机叠画（ADR-0059 的 453、458 修订）、谷歌的隔离框（[ADR-0057](0057-google-maps-plugin.md)）都照旧。

## 背景

- 445 把"一家地图服务"做成了插槽，谷歌地图（446）是经插槽接进来的独立插件；但地图插件自己还带着两家：守护进程 `map/` 里有 OpenStreetMap（瓦片转发、Nominatim / OSRM）和高德（Key、查询、用量、静态图、安全密钥代理），网页 `plugins/map/` 里有它们的引擎、填 Key 的那一块、演示页的假高德。设置 · 插件里只看得到"地图"和"谷歌地图"，高德、OpenStreetMap 停不了、移除不了。
- 地图插件里到处是 `"amap"`、`"osm"` 的字面量：挑底图、卡片的"数据来自"、深色预览图、"高德查来的只画在高德上"、没填 Key 的提醒、退路都写死这两家。再接一家要改地图插件。

## 决定

1. **四个插件**：`map`（地图页、足迹、聊天卡片、地图切换、`show_on_map` 和查地点算路线的工具、"地图服务"插槽、当前地图的规矩、本机叠画）、`openstreetmap`、`amap`、`google-maps`。三家都 `needs: [MAP_PROVIDERS]`，在 `setup` 里经 `ctx.effect` 登记一家；地图插件停了它们跟着停（运行中停的记成停用了，要各自再启用；配置里停着的，启用地图时跟着装上——宿主的规矩，不另写）。清单的先后：地图、OpenStreetMap、高德、谷歌（两份清单一样）。
2. **地图插件不认得任何一家**：守护进程、网页的地图插件目录里去掉注释后没有 `"amap"`、`"osm"`、`"google"` 这些编号，也不 import 哪一家的插件（`packages/daemon/test/map/boundary.test.ts`、`packages/web/test/plugins/boundary.test.ts` 查）。原来写死的地方改成看插槽：
   - 守护进程：瓦片 `/tiles/<编号>/…` 按编号交给那一家的 `tiles`（`MapTileServer`），`/_AMapService/…` 这类转发口按前缀交给那一家的 `proxy`（`MapProxy`）；那一家没开时回"这一家地图没接上（它的插件没启用）"（404）。工具说明里的几家名字和说法由各家给（`modelName`、`toolNote`），按优先级拼。卡片预览图有没有深色看各家静态地图的 `dark`（报成 `previewDark`）。体检的用量项照旧由地图插件替写了 `usage` 的那几家登记。
   - 网页：底图只从 `mapBasemaps` 插槽来。瓦片底图（OpenStreetMap）登记 `tiles`（瓦片地址、最大级别、署名），由地图插件自己的瓦片引擎（`plugins/map/tile-engine.ts`）画；要加载外站脚本的（高德、谷歌）登记 `prepare(key, kit)`。卡片"数据来自 X"写各家登记的 `credit`（谷歌是"Google 地图"），没填 Key 的提醒写各家登记的 `setup`（高德：国内）。"只能画在自己地图上"看各家报的 `ownBasemapOnly`，不认得的（那家停了、几家还没取到）一律当只能画在它自己的上。
3. **一家都用不了**：三家都停了，地图页那块空着（`data-basemap="none"`），写"没有能用的地图，去设置 · 插件里启用一家"、按钮去设置 · 插件；开着的那几家都没填 Key、都加载不上时写它们现在都用不了、按钮去设置 · 数据源。聊天卡片能自己画的只有瓦片底图，它也没开时只写字。管这个区域的一家都用不了时"自动"退到这个区域能手动选的（只开着谷歌、人在大陆时用谷歌，它自己转坐标）。
4. **高德的数据跟着高德插件**：数据源 `amap` 归高德地图插件（编号不变，密钥区那一格 `secrets/data-sources/amap.json` 原样认，不用重填）；用量从地图插件的 `map/amap-usage.json` 挪成 `amap/usage.json`，高德地图插件每次装上时看一眼：有旧的、没有新的才挪（改名，改名不行就复制再删，都不行就照旧读旧的、写一行日志），挪完 `map/` 空了就删掉；可以重复跑。"连数据删"删 Key、用量（新旧两处都列）。OpenStreetMap 的瓦片缓存在内核的 `cache/map-tiles/osm`，地点不变，"连数据删"归 OpenStreetMap 插件。地图插件的"连数据删"只剩聊天里的地图卡片。这台设备的手动选择（`ergo-map-choice`）存的是编号，编号没变，原样认。
5. **瓦片引擎留在地图插件**：工单原写"OpenStreetMap 插件带页面里自己画的引擎"。实现时引擎没有挪：地图页盖在高德、谷歌上面的那一层、聊天卡片的缩略图、演示页的假高德都用同一套瓦片引擎画点、线、字，挪进 OpenStreetMap 插件就成了别的插件 import 它（插件不许互相 import），停用 OpenStreetMap 时卡片缩略图、假高德也跟着坏。所以引擎是地图插件的通用件，OpenStreetMap 插件只给瓦片地址和署名；演示页的假高德经 `kit.tileEngine` 借它。

## 留着的写死的名字

挪不了、或者挪了更糟的，写明为什么：

- **网关认 `/_AMapService/` 这个前缀**（`gateway/map-routes.ts` 的 `isMapPath`，常量 `AMAP_SERVICE_PREFIX` 在协议包）：网关要先认出"这是地图的请求"，地图插件停着时才能回"地图插件没启用"而不是掉进静态文件；前缀后面交给谁是地图插件按插槽转的。
- **协议包里的几个常量**：`MAP_TILE_SOURCES = ["osm"]`（`parseMapTilePath` 认瓦片地址用，加一家瓦片底图要在这里加编号）、`AMAP_SOURCE_ID`、`GOOGLE_MAPS_SOURCE_ID`、`GOOGLE_MAP_PROVIDER`：协议包是两边共用的，各家插件的两半都从这里取，地图插件不用它们。
- **`MapConfigView` 里可选的 `amapKey`、`amapProblem`**：守护进程不再报、页面不再看，字段留着只为协议的样子不变。
- **核心样式表里的 `.map-amap`、`.amap-try`、`google-maps.css`**：网页插件没有自己的样式表这一层，样式都在 `packages/web/src/styles/`，照旧放那里。
- **原型**（`prototype/fake-map.ts`、`fake-plugins.ts`、`fake-http.ts`）：演示页扮守护进程，认得三家是应该的；只进演示页。

## 后果

- 设置 · 插件里看得到地图、OpenStreetMap、高德地图、谷歌地图四个，每家能单独停用、移除；停用高德后国内"自动"是 OpenStreetMap，切换菜单里没有高德。
- 再接一家（比如另一种瓦片底图）不用改地图插件：守护进程登记 `MapProvider`（瓦片的话在协议包 `MAP_TILE_SOURCES` 加编号），网页登记 `MapBasemapSlot`。插件开发手册拿 OpenStreetMap 当最小的例子。
- 停用地图插件再启用时，三家要各自再启用（运行中停的记成停用了）；这是宿主现有的规矩，没为地图另开口子。
- 旧版本守护进程（没有 `providers`）配新页面时地图页说没有能用的地图——页面和守护进程一起发，碰不到，去掉了按 `amapKey` 猜两家的退路。
