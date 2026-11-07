# ADR-0055 地图查地点、算路线：国外用 OpenStreetMap 的免费服务，工具改由地图插件自己登记

状态：已定（433，用户 2026-11-07 定：国外先用免费的 OpenStreetMap——Nominatim 查地点、OSRM 算路线，不接 Google；代价是没有公交、没有实时路况。国内照 ADR-0053 用高德；没填高德的 Key 时国内也用 OpenStreetMap 当退路）。改了 ADR-0053 的第 1 条。

## 背景

- ADR-0053 把五个工具做成数据源 `amap` 的按需查：内核只在高德连着时给秘书。没填高德的 Key、高德断开、Key 坏了，秘书就一个查地点的工具都没有——国外不需要高德也查不了。
- Nominatim 公共实例的政策（operations.osmfoundation.org/policies/nominatim/，2026-11-07 读的）：每秒最多 1 次、要能认出应用的 User-Agent 或 Referer（http 库默认的不行）、结果要自己缓存（同样的查询反复发会被当成坏客户端封掉）、不许在客户端做输入联想、不鼓励批量、要署名。OSRM 演示服务（FOSSGIS 在 routing.openstreetmap.de 上跑的，开车、步行、骑车分开）：每秒最多 1 次、合理的非商业用途、不保证可用；router.project-osrm.org 只有开车。
- 两家的坐标都是 WGS-84，和二狗里存的一样。

## 决定

1. **工具由地图插件自己登记**（`ctx.agent.tools.register`，给秘书）：插件在运行就有五个工具，不跟着高德连没连着走。数据源 `amap` 的按需查开关还在（设置 · 数据源上照样能开关），写成 `usages.query.ownTools: true`——内核不替它给工具（登记表核对：写了 `ownTools` 就不能再给 `tools()`，没写就必须给）。插件查国内的点之前经新的内核服务 `KERNEL.dataSourceUsage`（`on(id, usage)`，数据源服务的 `usageOn`）现看这个开关。没选"给 OpenStreetMap 也登记一个数据源"：两个数据源不能登记同名工具，拆成两套工具模型还要先猜去哪一家查。
2. **每次现给能用的几家**（`map/service.ts`）：高德能用（填了 Web 服务 Key、按需查开着、高德没说 Key 不对）时 `[高德, OpenStreetMap]`，不然只有 `[OpenStreetMap]`。高德只管中国大陆，OpenStreetMap 哪儿都管；工具按点挑排在前面、两头都管的那一家——有高德时国内走高德、国外和跨境的走 OpenStreetMap；没有高德时国内也走 OpenStreetMap，结果里提一句"国内的地点用 OpenStreetMap 查，店名和小路可能不全"（`coverageNote`），不说"要填高德 Key"。查的时候高德说 Key 不认，这一次照实说，之后国内改走 OpenStreetMap。
3. **按名字找先问谁**（`lookup-tools.ts` 的 `nameOrder`）：知道这一问的另一头在哪，管它的几家在前；不知道的看手机最近 2 小时内交来的位置（只在本机用来挑先后，不发出去）；都没有时带汉字的照原来的先后（先高德）、不带汉字的先 OpenStreetMap。问到的点不在那家管的范围里的去掉（高德搜出的国外的点），一家没找到或用不了再问下一家；排第一的那家用不了、别的也没找到时照它的错说。路线的另一头按名字找时，这一头的点作为"靠近这里"（Nominatim 的 viewbox，不限死）只发给要拿它算路线的那一家（管它、排在最前的）——它本来就要发给这一家；转去问别家的只带地名。
4. **守规矩写在一处**（`map/osm-client.ts`，一家服务一个）：一队、一次一个在路上，两次开始之间至少 1.1 秒，排队超过 8 个直接说太频繁；带和瓦片转发同一个 User-Agent（`ergo/<版本> (personal assistant; +https://github.com/catmaniii/ergo)`），不带 Referer；成功的结果按完整地址在内存里缓存一天、最多 200 份，同一个地址同时只发一次，出错的不缓存，插件停用时扔掉——不落盘、不进素材；只在模型调工具时发，不做联想、不批量。
5. **两家的读法**（`map/osm-lookup.ts`）：Nominatim `/search`、`/reverse`（`format=jsonv2`、`addressdetails=1`、`accept-language` 是界面语言加英文）；"附近"是中心四周的方框里找（`viewbox` + `bounded=1`），Nominatim 不按远近排，二狗多要几条、自己算距离、去掉圈外的；它列不出"附近有什么"的全部，没说找什么就不发请求、直接说要说找什么。OSRM `/routed-car/route/v1/driving`、`/routed-foot/route/v1/foot`，`overview=full&geometries=geojson` 拿整条折线；没有公交（不发请求，结果里说没有），开车用时写"按道路限速估的，不含实时路况"。
6. **各家的说法由各家给**：`LookupProvider` 多了 `credit`（结果末尾那句：数据来自谁、署名、存没存）、`routeModes` / `defaultModes`（OpenStreetMap 不写走法时算开车和步行）、`liveTraffic`、`browsesNearby`、`coverageNote`、`explain`（出错时的话：OpenStreetMap 连不上、429、403、5xx 一律"免费服务暂时不可用"，高德的是去哪重新填 Key、到上限）。工具不写死哪一家，工具说明里讲数据从哪来的那句由 `service.ts` 给。
7. **能画的那一份照旧只在内存里**，来源多了 `osm`（编号 `osm-p1`、`osm-r1`），431 照同一个形状画。

## 后果

- 没填高德的 Key 也能问路：国外完整可用（没有公交、路况），国内能用但店名、小路可能缺。
- OpenStreetMap 的公共服务一秒一次、一次一个：问一条带地名的路线要 3 次请求（找终点、开车、步行），大约 3 秒多。秘书一轮里连着查很多会排队、超过 8 个直接说太频繁。
- 一天的缓存在内存里：问同一处附近两次不会再发；守护进程重启就没了。
- 内核多了一个服务（`KERNEL.dataSourceUsage`）和一个数据源写法（`usages.query.ownTools`）；以后几家共用一套工具的按需查都能照这样写。
- 真的 Nominatim、OSRM 一次都没调过（测试不许连外网），响应照官方文档的字段读；中文地名在 Nominatim 上能不能找到要看 OpenStreetMap 里有没有 `name:zh`。
