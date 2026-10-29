// 打包进网页的自带语言（168 号票）：共享协议包 locales/ 下各语言的 _meta.json 和网页用到的区域（WEB_NAMESPACES），
// 构建时由 Vite 的 import.meta.glob 收进页面。原型（file://，没有守护进程）全靠它；由守护进程提供页面时它垫在守护进程给的词典下面
// （守护进程比网页旧时，网页新加的句子照样有）。
// 网页用到的区域加了一块：这里的花括号里加上，协议包的 WEB_NAMESPACES 也加上（守护进程的 test/i18n/keys.test.ts 比对两边）。
// 319 号票：setup 是首次设置向导的话（pages/SetupWizard.tsx），doctor 是设置 · 体检的话（pages/DoctorPage.tsx）。
import { catalogsFromFiles, type LocaleEntry } from "../state/index.ts";

const FILES = import.meta.glob("../../../protocol/locales/*/{_meta,common,shell,ui,app,model,styles,bridge,state,pages,protocol,harmony,setup,doctor}.json", { eager: true, import: "default" });

/** 自带的几种语言（中文、英文），只有网页用到的区域 */
export const BUNDLED_LOCALES: ReadonlyMap<string, LocaleEntry> = catalogsFromFiles(Object.entries(FILES));
