# ADR-0059 一个区域一家"当前地图"：地图页、足迹、聊天卡片的预览图都用它

状态：已定（451，用户 2026-11-09："只要我在海外没有配谷歌的 api key，那你就默认用高德的""把这个体验优化一下"）。修订 ADR-0052（足迹只在二狗里画）、ADR-0054（卡片只有 OpenStreetMap 画缩略图）、ADR-0056（插槽"自动"的挑法）和 ADR-0057（大陆外没填谷歌退回 OpenStreetMap）里对应的几条，其余照旧。

**453 修订**（见文末）：足迹和二狗画的点、线只在本机画，高德、谷歌只出底图（地图页盖一层自己的、谷歌关进隔离框；卡片的静态图只要光底图）——第 5 条的隐私、第 6 条的请求形状、第 7 条地图页的画法跟着改。

## 背景

- 地图的体验是割裂的：聊天卡片只有 OpenStreetMap 画得出缩略图，高德、谷歌查来的卡片只有字；画着足迹时一律换成 OpenStreetMap（11-07 定的，为了不让地图公司的脚本看到轨迹）；地图页等高德、谷歌的脚本时先画 OpenStreetMap，每次打开都闪一下；大陆外没填谷歌时是 OpenStreetMap；手动选了别家时点开高德查的卡片要点"换成高德"，还会改掉这台设备记着的选择。
- 用户实际的配置是高德、谷歌都填好了。他要的是"处处一样"，国外没填谷歌就用高德。
- 高德、谷歌的条款都要求它们查来的只画在它们自己的地图上，这一条不能动。

## 决定

1. **当前地图**：这台设备在一个区域（`mainland` 中国大陆、`abroad` 大陆以外）手动选的那家，没选就是"自动"挑的那家。地图页、开着足迹的地图页、某一天的足迹、聊天卡片的预览图都用它。只有一个例外：`ownBasemapOnly` 的那家查来的地点和路线永远画在它自己的地图上。
2. **"自动"按区域排先后**：插槽的 `MapProvider` 加可选的 `regionPriority: { mainland?, abroad? }`（没写的区域用 `priority`）。高德的 `regions`、`manualRegions` 加上 `abroad`，国外的优先级 30——国内 高德 100 > OpenStreetMap 0；国外 谷歌 50 > 高德 30 > OpenStreetMap 0。没改谷歌的数，所以别的插件照 445 写的优先级不受影响。地图切换菜单里，"自动"会挑的（`regions` 里有这个区域的）按优先级排前面，只能手动选的排后面。
3. **高德的查询照旧只管大陆**：插槽加可选的 `lookupRegions`（查询管的区域，没写同 `regions`）。高德写 `["mainland"]`：国外地图是高德时查询用 OpenStreetMap，OpenStreetMap 的结果画在哪家地图上都行。高德 Web 服务在国外能不能用没查实，先不开。
4. **高德国外的底图**：加载高德时带 `showOversea: true`。国外的详细地图是高德"世界地图"高级能力，要提工单开通；没开通时会很空，用户可以在切换里给国外选 OpenStreetMap。没权限时高德怎么表现不知道，不因此报错。
5. **足迹也跟着当前地图**：网页的 `FOOTPRINTS_ON_CURRENT_MAP = true`（原 `AMAP_WITH_FOOTPRINTS = false` 反过来、换个好懂的名字）。`lookupBasemap` 里"看足迹时查询不跟底图"的特例没了，交给秘书的地图编号就是画着的那一家；输入附注不再写"看足迹时底图一律 OpenStreetMap"。隐私变了：当前地图是高德、谷歌时，页面里它们的脚本看得到画上去的轨迹、停留、照片地点，预览图的请求里也带着点和线。手册写明，选 OpenStreetMap 就和原来一样。
6. **聊天卡片都有预览图，静态地图经守护进程取**：
   - 插槽加可选的 `staticMap(req, signal)`：交一张这家的静态地图（图片和上游的缓存头），或者取不到的原因（`no_key`、`off`、`over`、`key`、`quota`、`network`、`other`）。Key 只在守护进程里用。`GET /api/map/config` 的每一家多报 `preview`（有没有 `staticMap`）和 `regionPriority`。
   - 新接口 `GET /api/map/preview?card=|lookup=&provider=&w=&h=&dark=1&scale=`：按卡片编号或查询编号现取内容（卡上的点和路线、某一天的足迹、内存里的查询结果），**地址里不放坐标**；没写 `provider` 时查到的用查它的那家。地图插件把内容整理成同一种请求（`map/static-map.ts`：最多 10 个点——足迹按停留时间长的挑、查到的按排名，序号 1–9、第 10 个不标；最多 4 条线、合计 200 个点以内用 `thinLine` 抽稀；视野按 Web 墨卡托算整数级别看全），各家只管拼自己的参数。取不到回 503 加一句原因，卡片或查询不在了回 404，参数不对回 400。不缓存，上游的 `Cache-Control` 照转（没给就 `no-store`）。
   - **高德**：`/v3/staticmap`，Web 服务 Key，记进高德用量的 `lbs`；`size` 最大 1024、`zoom` 1–17、`scale=2`、markers 10 个、paths 4 条、GCJ-02。高德的错误是 200 加 JSON 的 infocode，照查询那一套分类。没有深色，网页压暗一点。
   - **谷歌**：Maps Static API，服务端 Key；`size` 最大 640、`scale=2`、`format=png`、`language` 跟界面、线用 `enc:` 编码折线、深色用 `colorscheme=dark`、大陆里转 GCJ-02。新计费项 `staticMaps`（每月 1 万次免费、八成提醒、超了没放开不出图，不影响底图和查询）。403 记成"预览图：没开"（Maps Static API 没开、服务端 Key 的 API 限制没勾它都是这个），设置 · 数据源 · 谷歌地图上标出来；测服务端 Key 时多取一张 64×64 的试它，没开不挡保存。
   - **网页挑哪家**（`plugins/map/providers.ts` 的 `cardBasemap`）：查到的用查它的那家；足迹、点、路线、OpenStreetMap 查的用内容中心那个区域的当前地图。那家报了 `preview` 才取图，否则（OpenStreetMap、旧守护进程）照原来自己画 OpenStreetMap。看到了才取（IntersectionObserver），宽度取整到 40 的倍数、最宽 640。取不到时：足迹、点、路线退回自己画 OpenStreetMap；查到的只有字，加一句"预览图没出来：<原因>"和"在<那一家>上看"。聊天页照旧不加载高德、谷歌的脚本。
7. **地图页**：
   - 当前地图的脚本加载着时不先画 OpenStreetMap：地图那块是空的、写"正在加载<那一家>…"（`data-basemap="loading"`），加载失败或 20 秒没好才退到下一家。
   - 点开别家查到的卡片：这一屏临时用查它的那家（`pickBasemap` 的 `temporary`，不改记着的选择），地图上面写"这些是<那一家>查的，所以用<那一家>显示"；关了卡片回到当前地图。原来的"换成 X"按钮去掉。
   - 那家在这台设备上加载不了（设备在大陆连不上谷歌）：地图那块放这张卡的静态大图（同一个接口，最大 1024），写"这台设备连不上<那一家>，先给你看一张图"；大图也取不到时照旧说画不上去。
8. **演示页**：假的静态预览图（占位瓦片拼成的 SVG，带"演示图"）；`?demo-plugins-off=google-maps` 国外"自动"是高德；`?demo-google=unreachable` 扮这台设备连不上谷歌，`?demo-map-preview=google-off` 扮 Maps Static API 没开。原型多一张"周末想去的三处"（秘书给的点）。

## 后果

- 用户要在 Google Cloud 多开 Maps Static API，服务端 Key 的 API 限制里也勾上（手册写了）；不开也照常用，只是谷歌查的卡片只有字。
- 高德国外的地图要提工单开通世界地图，否则国外"自动"是一张很空的高德地图——这是用户要的默认（"海外没配谷歌就用高德"），手册写了怎么改选 OpenStreetMap。
- 每张高德预览图算一次 Web 服务调用（`lbs`，每月 15 万）；谷歌每张算一次 `staticMaps`。聊天里看到才取、不缓存，翻聊天记录会多算几次。
- 隐私比 11-07 的做法松：当前地图的那家看得到足迹。这是用户这次明说要的，ADR-0052 的"只在二狗里画、不发给任何地图服务"改成"足迹本身不联网算，画出来时当前地图那家看得到"。
- 没用真 Key 调过高德、谷歌的静态地图：参数照官方文档（2026-11 读的），测试用本机的假高德、假谷歌；第一次真用时要看一眼图对不对（尤其高德的 GCJ-02 和标注、谷歌的深色）。

## 453 修订：足迹和二狗画的点、线只在本机画，高德、谷歌只出底图

状态：已定（453，2026-11-09）。改上面第 5 条的隐私、第 6 条的请求形状、第 7 条地图页的画法和"后果"里隐私那一条；"当前地图""自动"的挑法、查询跟着地图走、高德谷歌查来的只画在它们自己的地图上，都照旧。

### 背景

451 以后足迹画在当前地图上：地图页把轨迹、停留、照片地点交给高德、谷歌的脚本画（`setScene` → 它们的 Marker / Polyline），聊天卡片的静态图请求里也带着点和线（高德 `markers` / `paths`、谷歌 `markers` / `path`）。用户要"处处一样"，也要地图公司看不到足迹。两件事并不冲突：底图照旧用当前地图，点和线不交给它们，自己画在上面。

### 条款（2026-11-09 读的）

- 谷歌 [Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms)：3.2.2(b) 要显示谷歌给的署名（标志、版权），不得修改、遮挡、删除；3.2.3(e) 不得把 Core Services 和"非谷歌地图"一起用。没有一条不许在谷歌地图上画自己的东西。[Maps JavaScript API 的政策和署名](https://developers.google.com/maps/documentation/javascript/policies)：署名要清楚、不改、不挡。[Maps Static API 的概览](https://developers.google.com/maps/documentation/maps-static/overview)、[开发指南](https://developers.google.com/maps/documentation/maps-static/start)只讲参数；它的专门政策页（`/maps-static/policies`）今天是 404。[Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) 里 Maps Static API 没有另加限制。我们画的是自己的点（不是谷歌的地点数据），叠在谷歌地图上，不挡标志和版权——条款允许。
- 高德 [开放平台服务协议](https://lbs.amap.com/home/terms/)：4.10.7 不得删除或遮挡版权、商标声明；4.10.6 要依法标注审图号、不得"擅自修改变更本服务的展示形式和或内容"；4.12.2 不得对地图数据"复制、更改、修改、挂接运行或创作任何衍生作品"；4.12.4 不能脱离本服务单独展示、不能"擅自修改本服务的名称、展示方式"。在高德地图上加自己的标注是它 JS API 和[静态地图](https://lbs.amap.com/api/webservice/guide/api/staticmaps/)的本来用法（覆盖物、`markers`、`paths`），我们画在它上面一层、不改它的图、不挡标志和审图号，按通常理解不算"修改展示方式"。**4.12.2、4.12.4 的字面很宽**，没有一句明说"可以在静态图或地图上面叠自己的图层"，这一点记下来，真有疑问要问高德。
- 落实：静态图下面那一条（左下标志、右下版权和审图号）自己那一层不画进去（网页 `LOGO_BAND = 24`，守护进程看全时下面多留 28 像素）；地图页那一层是透明的，只有点本身挡住下面——点拖到标志上时盖住一点，和地图公司自己的覆盖物（以前画点用的就是它们）一样，停下来不会一直挡着。

### 决定

1. **聊天卡片的静态图只要光底图**：`MapStaticRequest` 只剩中心（那家的坐标）、整数级别、宽高、`scale`、`dark`；`staticMap` 从函数改成 `MapStaticSource`（`maxSide`、`minZoom`、`maxZoom`、可选的 `maxZoomHiDpi`、`datum`、`get`）。地图插件的 `planStatic` 照要看全的东西（停留和照片、搜到的、点和线）算中心和级别，回应头写 `X-Map-View`（协议包 `MapPreviewView`：WGS-84 的中心、级别、宽高、`scale`、`datum`）。网页照它在本机投影（Web 墨卡托、`gcj02` 的先转），图是 `object-fit: cover` 就照着摆，点带序号、**不再限 10 个、不再只标 1–9**，线照画。高德 `scale=2` 在 17 级不再加一级，高清图最大收到 16 级（不然看的范围对不上）。
2. **地图页：高德、谷歌只出底图**：引擎分两种——自己画点线的（OpenStreetMap，`setScene`）和只出底图的（没有 `setScene`，每动一下报 `onSurface(MapSurfaceView)`，能 `panBy`）。地图页在只出底图的上面盖一层自己的（`plugins/map/overlay.ts`），每次报来当场重摆（同一帧，不等下一帧）；这一层不接手势（`pointer-events: none`），只有点能点、按住点拖转成 `panBy`。高德的引擎里一个覆盖物都不建，旋转、倾斜关掉（这一层按正北、平面投影）。
3. **谷歌关进隔离框**：谷歌的脚本在 `<iframe sandbox="allow-scripts">` 里跑（不透明来源：读不到地图页、`localStorage`、Cookie；右侧的聊天窗、足迹都在框外面）。框的页面是网页包的 `public/map-frame.html`，网关按 `/map-frame.html` 给（回应头再写一遍 `sandbox allow-scripts` 和 `frame-ancestors 'self'`，外网端口一样要设备凭证）；用 URL 不用 `srcdoc`——谷歌按文档地址查 Key 的网站限制，`srcdoc` 报的是 `about:srcdoc`。外层经 `postMessage` 交给框的只有一段代码（`google-bridge.ts` 的小桥，整段 `toString()` 过去）、设置（Key、版本、语言、起始视野、深浅）和视野指令（`setView`、`zoomBy`、`panBy`、`setDark`）；框里报回 `surface`、`moveend`、`loaded`、`ready`、`failed`。外层只认自己那个框发来、带 `ergoMapFrame` 记号的。框里加载着时地图页照"还在加载"显示（引擎的 `loading` / `onReady`），18 秒没回话算加载不了。`GOOGLE_FRAME_ISOLATED` 是退回同页的开关（真机上框跑不通时改一处），同页时数据照样不交给谷歌。
4. **高德退回同一个页面**：票里要先试把高德也关进框。做不到：高德的安全密钥由守护进程的 `/_AMapService` 代理拼上，代理在外网端口要设备凭证（`SameSite=Strict` 的 Cookie，不透明来源的框里带不上），本机端口查 `Origin`（框里是 `null`，被拒）。要让框里能用就得给代理开一条凭证以外的口子（比如一次性的令牌），这是新的安全设计——照"新安全设计只记录不实现"的规矩先不做。所以高德在同一页里跑、只出底图：足迹不交给它，但它的脚本技术上读得到这一页；手册和设置里照实写，介意的给国内选 OpenStreetMap。
5. **"回到我现在的位置"**的蓝点、精度圈也画在自己那一层（以前在高德上是高德的 Marker / Circle）。

### 量过的

- 原型（演示页、假谷歌在隔离框里、`file://`、无头 Chrome）：拖动加惯性 59 次报视野，框里读到 → 外层重摆完中位 0.3 毫秒、p95 1.8 毫秒、最慢 2.4 毫秒；滚轮缩放 8 次，中位 0.8 毫秒、最慢 8.2 毫秒——都在同一帧里（一帧 16.7 毫秒）。先前的单独原型里改成"等下一帧再画"会慢一帧，所以当场画。
- 不要 Key 时真的谷歌脚本在 URL 隔离框里能加载、建地图、出瓦片（报的是没 Key 的错，地图照出）；框里发出去的请求不带 `Referer`。**带网站限制的真 Key 在框里过不过没验证到**（测试和原型不用真 Key），上线后用真 Key 看一眼；过不了把 `GOOGLE_FRAME_ISOLATED` 改成 `false`。

### 后果

- 隐私回到"地图公司只知道你在看哪一片"：足迹、查到的点和线、你现在的位置都不交给高德、谷歌的脚本和接口。谷歌连页面都读不到；高德读得到页面（同页），这一条手册写了。
- 地图页多一层自己的东西：点的样子在三种底图上一样了（以前高德、谷歌各画各的）。谷歌缩放动画中途（谷歌报的级别直接跳到目标）这一层可能和底图差一点，停下来就对齐；没用真谷歌量过。
- 静态图的对齐靠"同一套 Web 墨卡托公式 + 图是这家按我们给的中心和级别出的"：真高德、真谷歌的图上点对不对得上，没用真 Key 看过（演示页的假图是同一套公式拼的，必然对得上）。
- 插槽的 `staticMap` 外形变了（函数 → `MapStaticSource`）。只有地图插件、谷歌地图插件两家实现，一起改了；以后接进来的照新的写。
