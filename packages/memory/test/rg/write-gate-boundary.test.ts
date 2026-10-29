// 267 号票：推理图谱只有一个写入口。代码里除了存储本身（store/store.ts）和写入口（rg/write-gate.ts），
// 谁都不直接调存储的写操作（证据、事实、结论、关联、推断、追问、预测），也不拿 SQL 直接改这几张表——
// 一律经 engine.gate（或 rgWriter / rgSession）写，写之前过检查、写完留痕。测试夹具可以直接往库里灌（那是测试的事）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** 存储上写推理图谱（和它底下的证据、事实层）的操作 */
export const GATED_WRITES = [
  "insertEvidence",
  "updateEvidence",
  "deleteEvidence",
  "insertFact",
  "updateFact",
  "deleteFact",
  "insertClaim",
  "updateClaim",
  "putLink",
  "removeLink",
  "insertInference",
  "updateInference",
  "insertProbe",
  "updateProbe",
  "putPrediction",
  "updatePrediction",
] as const;

const ALLOWED = new Set(["store/store.ts", "rg/write-gate.ts"]);
const DIRECT = new RegExp(`\\bstore\\??\\.(${GATED_WRITES.join("|")})\\(`);
const RAW_SQL = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:evidence|facts|claims|links|inferences|probes|predictions)\b/i;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("唯一写入口：记忆包的代码不绕过它", () => {
  it("除了存储和写入口，没有地方直接调存储的写操作、直接拿 SQL 改推理图谱的表", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replaceAll("\\", "/");
      if (ALLOWED.has(rel)) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
          if (DIRECT.test(line) || RAW_SQL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
