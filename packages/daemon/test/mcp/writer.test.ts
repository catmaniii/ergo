// MCP 登记文件的写入（239 号票，单元）：按 name 合并、别的一条不动、原子写（同目录临时文件 + rename）、
// 写前把旧的留一份进 config/.history/、只留最近几份；现在的登记文件写坏了（JSON 坏、条目不合 schema）不动它、直接说明原因。
// 工具和卡的切面在 registration-change.test.ts，端到端的在主切面 test/main/mcp-registration.test.ts。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { RequestRejected } from "../../src/errors.ts";
import { applyMcpChange } from "../../src/mcp/writer.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 临时配置区里的登记文件和历史区 */
function configDir(initial?: unknown) {
  const root = makeTempDir("ergo-mcp-config-");
  const layout = dataDirLayout(root);
  fs.mkdirSync(layout.config, { recursive: true });
  if (initial !== undefined) fs.writeFileSync(layout.mcpFile, typeof initial === "string" ? initial : JSON.stringify(initial, null, 2));
  return { file: layout.mcpFile, historyDir: path.join(layout.config, ".history"), root };
}

const demo = { title: "假 MCP", command: "node", args: ["x.js"], tools: { echo: { title: "原样回话", readOnlyOrIdempotent: true, network: false } } };
const notes = { command: "node", args: ["notes.js"], tools: { search: { title: "搜笔记" } } };

describe("登记文件的写入", () => {
  it("按 name 合并、别的一条不动；原子写、写前留一份备份", () => {
    const at = "2026-10-21T10:00:00.000+08:00";
    const { file, historyDir } = configDir({ servers: { demo, notes } });
    const before = fs.readFileSync(file, "utf8");
    const written = applyMcpChange({ file, historyDir }, { action: "add", name: "album", registration: { ...demo, title: "旅行相册" } }, at);
    expect(written).toMatchObject({ before: ["demo", "notes"], after: ["album", "demo", "notes"] });
    const read = JSON.parse(fs.readFileSync(file, "utf8")) as { servers: Record<string, unknown> };
    // 原有的两条一字不差，新的那条在里面
    expect(read.servers.demo).toEqual(demo);
    expect(read.servers.notes).toEqual(notes);
    expect(read.servers.album).toMatchObject({ title: "旅行相册" });
    // 写前的那一份进了历史区
    expect(fs.readFileSync(written.backup!, "utf8")).toBe(before);
    expect(path.basename(written.backup!)).toBe("mcp-20261021100000000.json");
    // 配置区里没有留下的临时文件
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("改一条只换这一条；删一条只去掉它；历史区只留最近几份", () => {
    const { file, historyDir } = configDir({ servers: { demo, notes } });
    applyMcpChange({ file, historyDir, keepHistory: 3 }, { action: "update", name: "demo", registration: { ...demo, title: "改过的" } }, "2026-10-21T10:00:00.000+08:00");
    applyMcpChange({ file, historyDir, keepHistory: 3 }, { action: "remove", name: "notes" }, "2026-10-21T10:01:00.000+08:00");
    applyMcpChange({ file, historyDir, keepHistory: 3 }, { action: "add", name: "album", registration: demo }, "2026-10-21T10:02:00.000+08:00");
    applyMcpChange({ file, historyDir, keepHistory: 3 }, { action: "remove", name: "album" }, "2026-10-21T10:03:00.000+08:00");
    const read = JSON.parse(fs.readFileSync(file, "utf8")) as { servers: Record<string, { title?: string }> };
    expect(Object.keys(read.servers)).toEqual(["demo"]);
    expect(read.servers.demo!.title).toBe("改过的");
    // 只留最近 3 份（最早的两次已经删掉）
    expect(fs.readdirSync(historyDir).toSorted()).toEqual(["mcp-20261021100100000.json", "mcp-20261021100200000.json", "mcp-20261021100300000.json"]);
  });

  it("现在的登记文件写坏了：不动它，写明哪里不对", () => {
    for (const bad of ["{ 不是 JSON", JSON.stringify({ servers: { demo: { tools: {} } } })]) {
      const { file, historyDir } = configDir(bad);
      let rejected: RequestRejected | undefined;
      try {
        applyMcpChange({ file, historyDir }, { action: "add", name: "album", registration: demo }, "2026-10-21T10:00:00.000+08:00");
      } catch (err) {
        rejected = err as RequestRejected;
      }
      expect(rejected).toBeInstanceOf(RequestRejected);
      expect(rejected!.code).toBe("bad_params");
      expect(fs.readFileSync(file, "utf8")).toBe(bad);
      expect(fs.existsSync(historyDir)).toBe(false);
    }
  });
});
