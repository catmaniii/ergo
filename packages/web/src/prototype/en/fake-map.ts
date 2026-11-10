// fake-map.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_MAP: Phrases = {
  "高德地图": "AMap",
  "谷歌地图": "Google Maps",
  "附近的 hawker centre": "Hawker centres nearby",
  "当前位置": "Current location",
  "杭州 · 西湖": "Hangzhou · West Lake",
  "新加坡 · 滨海湾": "Singapore · Marina Bay",
  "演示底图：编的街区，不是真的地图": "Demo basemap: made-up streets, not a real map",
  "演示图": "Demo",
  "从公司到西湖边": "From the office to West Lake",
  "西湖边": "West Lake",
  "这次查到的地点和路线已经过期了（只在这台电脑上留一会儿、不存）：再问一次就有": "These places and routes have expired (they're only kept on this computer for a little while and never saved): ask again",
  "地图上没找到「{}」：选得具体些（带上城市、区）再试": "Couldn't find “{}” on the map: select something more specific (with the city or district) and try again",
  "附近的咖啡馆": "Cafés nearby",
  "（原型）标好了：附近 3 家咖啡馆，都在地图上了。": "(Demo) Done: 3 cafés nearby, all on the map now.",
  "湖边咖啡": "Lakeside Café",
  "转角咖啡": "Corner Café",
  "书店咖啡": "Bookshop Café",
  "附近的地铁站": "Metro stations nearby",
  "（原型）两个地铁站也标上了，和刚才的叠在一起。": "(Demo) Added the two metro stations on top of the earlier ones.",
  "地铁站 · 东口": "Metro · East exit",
  "地铁站 · 西口": "Metro · West exit",
  "（原型）公司标上了。": "(Demo) Marked the office.",
  "（原型）换好了：地图上只留这一次标的。": "(Demo) Switched: only these are on the map now.",
};
