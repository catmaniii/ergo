// 多语言（168 号票）：语言文件的形状和检查（catalog.ts）、运行时的 t() 和按语言格式化（runtime.ts）。
// 都不读文件、不碰 DOM，网页、守护进程、共享协议包共用；读目录在守护进程（daemon/src/i18n/），打包自带的在网页（web/src/app/locale-bundle.ts）。
export * from "./catalog.ts";
export * from "./runtime.ts";
