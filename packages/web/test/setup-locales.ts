// vitest 的 setupFiles（168 号票）：每个测试文件开始前装上自带的中文（直接读共享协议包的 locales/），
// 状态层、界面里调 t() 的测得到中文；要测英文的用例自己 setActiveLocale 换。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeLocaleFrom, catalogsFromFiles, DEFAULT_LANGUAGE, setActiveLocale } from "../src/state/index.ts";

const root = fileURLToPath(new URL("../../protocol/locales/", import.meta.url));
const entries = fs.readdirSync(root).flatMap((id) =>
  fs
    .readdirSync(path.join(root, id))
    .filter((name) => name.endsWith(".json"))
    .map((name) => [`${id}/${name}`, JSON.parse(fs.readFileSync(path.join(root, id, name), "utf8"))] as const),
);
/** 自带的几种语言（测试里切英文用） */
export const TEST_LOCALES = catalogsFromFiles(entries);
setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
