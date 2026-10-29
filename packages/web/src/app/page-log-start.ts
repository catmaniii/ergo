// 页面日志（124 号票：Debug 工具集）尽早开始收：main.tsx 第一个 import 的就是这个文件，ES 模块按 import 的先后执行，
// 后面那些模块执行时出的错、打的 console.error 都收得到。
import { startPageLog } from "./page-debug.ts";

startPageLog();
