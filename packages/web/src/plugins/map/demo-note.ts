// 演示页的底图是编的（429）：地图页、聊天卡片的缩略图在署名后面写一句"演示图"。安装版这个分支摇掉（字面的 MODE 比较）。
import { demoBasemapNote } from "../../prototype/fake-map.ts";

/** 演示页那一句（取值函数）；真的页面是 undefined */
export const demoBasemapNoteText = import.meta.env.MODE === "demo" ? demoBasemapNote : undefined;
