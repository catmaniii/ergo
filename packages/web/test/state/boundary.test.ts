// 前端状态层只能是纯函数（规格第 19 节）：不依赖 React 和 DOM，才能拿事件流直接在 Node 里回放。
// 规则：src/state/ 里的文件只许 import src/state/ 里的其他文件（04 号票起再放行 @ergo/protocol）。
// 不许用 DOM 和 Node 的全局量由 tsconfig.state.json 检查（那里不给 DOM 和 Node 的类型）。
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const STATE_DIR = path.resolve(import.meta.dirname, "../../src/state");
const ALLOWED_PACKAGES = new Set<string>(["@ergo/protocol"]);
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

test("状态层只引用自己目录里的模块", () => {
  const violations: string[] = [];
  for (const name of fs.readdirSync(STATE_DIR, { recursive: true, encoding: "utf8" })) {
    if (!/\.tsx?$/.test(name)) continue;
    const file = path.join(STATE_DIR, name);
    for (const match of fs.readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = match[1]!;
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec);
        if (!target.startsWith(STATE_DIR + path.sep)) violations.push(`${name}: 引用了状态层之外的 ${spec}`);
      } else if (!ALLOWED_PACKAGES.has(spec)) {
        violations.push(`${name}: 引用了外部包 ${spec}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
