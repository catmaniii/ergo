// MCP 给体检的（411，mcp.ts 的 doctorFacts）：mcp.json 读不出来的原因（这时文件里的 MCP 一个都用不了）；
// 登记要从环境取、守护进程的环境里却没有的凭据（按 MCP 列出缺哪几个变量）。只读文件和环境，不拉起服务进程。
import fs from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createMcpService } from "../../src/mcp/mcp.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function mcpWith(content: string | undefined, parentEnv: Record<string, string | undefined>) {
  const layout = dataDirLayout(makeTempDir("ergo-mcp-doctor-"));
  fs.mkdirSync(layout.config, { recursive: true });
  if (content !== undefined) fs.writeFileSync(layout.mcpFile, content);
  const mcp = createMcpService({ file: layout.mcpFile, parentEnv, cwd: makeTempDir("ergo-mcp-doctor-cwd-"), newJob: () => undefined, callTimeoutMs: 5_000, log: () => {} });
  onTestFinished(() => mcp.stop());
  return { mcp, file: layout.mcpFile };
}

const entry = (title: string, env: Record<string, unknown>) => ({ title, command: "node", args: ["server.mjs"], env, tools: { ping: { title: "试一下", network: false } } });

describe("MCP 给体检的（411）", () => {
  it("没有 mcp.json、凭据都在：没有问题", () => {
    expect(mcpWith(undefined, {}).mcp.doctorFacts()).toMatchObject({ missingEnv: [] });
    const ok = mcpWith(JSON.stringify({ servers: { gh: entry("GitHub", { GITHUB_TOKEN: { fromEnv: "GH_TOKEN" }, MODE: "read" }) } }), { GH_TOKEN: "x-test-token" });
    expect(ok.mcp.doctorFacts()).toEqual({ file: ok.file, missingEnv: [] });
  });

  it("登记要的凭据环境里没有（没设、空的）：按 MCP 列出缺哪几个变量，给人看的名字照登记", () => {
    const { mcp } = mcpWith(
      JSON.stringify({ servers: { gh: entry("GitHub", { GITHUB_TOKEN: { fromEnv: "GH_TOKEN" } }), notes: entry("笔记", { A: { fromEnv: "NOTES_A" }, B: { fromEnv: "NOTES_B" } }) } }),
      { NOTES_B: "" },
    );
    expect(mcp.doctorFacts().missingEnv).toEqual([
      { server: "gh", title: "GitHub", variables: ["GH_TOKEN"] },
      { server: "notes", title: "笔记", variables: ["NOTES_A", "NOTES_B"] },
    ]);
  });

  it("mcp.json 读坏了：交回原因（写着哪个文件），这时没有别的可查", () => {
    const { mcp, file } = mcpWith("{ servers: 不是 JSON", {});
    const facts = mcp.doctorFacts();
    expect(facts.problem).toContain(file);
    expect(facts.missingEnv).toEqual([]);
  });
});
