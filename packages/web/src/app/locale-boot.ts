// 页面一开始装上语言（从 main.tsx 挪出来）：ES 模块先把引到的模块都加载完才跑 main.tsx 自己的代码，在那里装的话，
// 界面各模块在模块顶层取的字（协议包 tTable 的值、followLocale 的常量）取的时候还没有语言，拿到的是 key 或者空串。
// main.tsx 排在界面各模块（App）前面引它；它引的 locale.ts、状态层在模块顶层不取字
// 演示页按地址的 ?lang= 定语言；安装版被直接打开（file://）时跟系统语言（app/prototype-mode.ts）
import { bootLocale, prototypeLanguage } from "./locale.ts";
import { isPrototypePage, openedWithoutDaemon, systemLanguage } from "./prototype-mode.ts";

const fixedLanguage = isPrototypePage(import.meta.env.MODE) ? prototypeLanguage() : openedWithoutDaemon(window.location.protocol, import.meta.env.MODE) ? systemLanguage(navigator.language) : undefined;
bootLocale(() => window.localStorage, fixedLanguage);
