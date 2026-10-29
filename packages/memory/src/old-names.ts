// ergou 换成 ergo 之后认旧名字（312 号票）：和协议包的 old-names.ts 同一条规矩（读新旧都认、新的优先；旧名字从新名字推出来），
// 记忆 PoC 不依赖协议包，这里放一份同样的小函数。
import fs from "node:fs";
import path from "node:path";

/** 新名字对应的旧名字：ergo / Ergo / ERGO 换成 ergou / Ergou / ERGOU（ERGO_MODELS_DIR → ERGOU_MODELS_DIR，.ergo → .ergou） */
export function oldNameOf(name: string): string {
  return name.replace(/ergo(?!u)/gi, (m) => m + (m === m.toUpperCase() ? "U" : "u"));
}

/** 环境变量：新名字的值，没设（或空）时用旧名字的 */
export function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  return env[name] || env[oldNameOf(name)] || undefined;
}

/** 目录：新名字的不在、最后一段换成旧名字的在时用旧的 */
export function pathOrOld(p: string): string {
  if (fs.existsSync(p)) return p;
  const old = path.join(path.dirname(p), oldNameOf(path.basename(p)));
  return old !== p && fs.existsSync(old) ? old : p;
}
