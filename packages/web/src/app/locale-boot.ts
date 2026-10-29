// 页面一开始装上语言（172 号票从 main.tsx 挪出来）：ES 模块先把引到的模块都加载完才跑 main.tsx 自己的代码，在那里装的话，
// 界面各模块在模块顶层取的字（协议包 tTable 的值、followLocale 的常量）取的时候还没有语言，拿到的是 key 或者空串。
// main.tsx 排在界面各模块（App）前面引它；它引的 locale.ts、状态层在模块顶层不取字（170 号票）
// 原型（file://）和在线演示页（316 号票）都按地址的 ?lang= 定语言（app/prototype-mode.ts）
import { bootLocale, prototypeLanguage } from "./locale.ts";
import { isPrototypePage } from "./prototype-mode.ts";

bootLocale(() => window.localStorage, isPrototypePage(window.location.protocol, import.meta.env.MODE) ? prototypeLanguage() : undefined);
