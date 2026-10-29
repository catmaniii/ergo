// 进程一开始装上自带的中文（172 号票）：main.ts 最先引它。ES 模块先把引到的模块都加载完才跑 main.ts 自己的代码，
// 等守护进程起来再装的话，各模块在模块顶层取的字（协议包 tTable 的值、followLocale 的常量）取的时候还没有语言，拿到的是 key 或者空串
import { installBuiltinLocales } from "./builtin.ts";

installBuiltinLocales();
