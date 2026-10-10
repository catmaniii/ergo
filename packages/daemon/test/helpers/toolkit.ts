// 27 号票（skill 库、MCP 登记与工具包）的测试底座：
// - 往数据目录配置区写 MCP 登记（mcp.json），服务进程是测试里的假 MCP 服务（fixtures/fake-mcp-server.mjs，随测试起停，不连任何真的 MCP）；
//   凭据经守护进程的环境变量 MCP_TOKEN_ENV 按登记注入（fromEnv）；
// - 读假 MCP 服务的记录（起来时的 pid、收到的凭据、每次调用）；
// - 写一个 skill 目录（SKILL.md），skill 库的 HTTP 接口（导入单个、导入并改名、整套导入集合；秘书用的 skill，72 号票）；
// - 放进项目列表一个立项书已确认、带工具包的项目（维护者休眠，用户在它的会话里说话时唤起）。
import fs from "node:fs";
import path from "node:path";
import { HTTP_PATHS, type ImportSkillBody, type ImportSkillResult, type PlanToolkit, type Project, type SecretarySkillsView, type ToolkitCatalog } from "@ergou/protocol";
import type { Daemon } from "../../src/daemon.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { requestJson } from "./http.ts";
import { seedProject } from "./projects.ts";

export const FAKE_MCP_SERVER = path.join(import.meta.dirname, "..", "fixtures", "fake-mcp-server.mjs");

/** 守护进程环境里放凭据的变量名（登记里写 { fromEnv: 它 }） */
export const MCP_TOKEN_ENV = "ERGOU_TEST_MCP_TOKEN";
/** 测试用的凭据（不是真的） */
export const MCP_TOKEN = "fake-mcp-credential-27";

/** 假 MCP 服务的登记：demo（几个工具各有类别、联网标记；status 授权给秘书快速动作） */
export function writeMcpRegistration(dataDir: string, logFile: string, extra: Record<string, unknown> = {}): void {
  const { config, mcpFile } = dataDirLayout(dataDir);
  fs.mkdirSync(config, { recursive: true });
  const registration = {
    servers: {
      demo: {
        title: "假 MCP",
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: { FAKE_MCP_LOG: logFile, FAKE_MCP_TOKEN: { fromEnv: MCP_TOKEN_ENV } },
        tools: {
          echo: { title: "原样回话", readOnlyOrIdempotent: true, network: false },
          env_token: { title: "看凭据在不在", readOnlyOrIdempotent: true, network: false },
          send_note: {
            title: "发笔记",
            categories: ["external_send"],
            args: { to: { kind: "recipient" }, text: { kind: "content" } },
            outbound: true,
            network: true,
          },
          wait: { title: "等一会儿", readOnlyOrIdempotent: true, network: false },
          status: { title: "看状态", readOnlyOrIdempotent: true, network: false, quickAction: { title: "看一下假 MCP 的状态", args: {} } },
        },
      },
      ...extra,
    },
  };
  fs.writeFileSync(mcpFile, JSON.stringify(registration, null, 2));
}

/** 假 MCP 服务记下的东西 */
export interface McpLogEntry {
  started?: { pid: number; ppid: number; token: string | null };
  call?: string;
  args?: Record<string, unknown>;
}

export function mcpLog(file: string): McpLogEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as McpLogEntry);
}

/** 写一个 skill 目录（含 SKILL.md） */
export function writeSkill(dir: string, name: string, description: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n照着做。\n`);
  return dir;
}

export const toolkitApi = {
  catalog: (url: string) => requestJson<ToolkitCatalog>(url, HTTP_PATHS.toolkitCatalog),
  /** 导入：给路径是单个 skill，给整个请求体可以改名、整套导入集合 */
  importSkill: (url: string, source: string | ImportSkillBody) =>
    requestJson<ImportSkillResult & { message?: string; code?: string }>(url, HTTP_PATHS.skillImport, { method: "POST", body: typeof source === "string" ? { path: source } : source }),
  secretarySkills: (url: string) => requestJson<SecretarySkillsView>(url, HTTP_PATHS.secretarySkills),
  setSecretarySkills: (url: string, skills: string[]) => requestJson<SecretarySkillsView & { message?: string; code?: string }>(url, HTTP_PATHS.secretarySkills, { method: "POST", body: { skills } }),
};

/** 工具包 */
export const toolkit = (overrides: Partial<PlanToolkit> = {}): PlanToolkit => ({ skills: [], mcp: [], bash: false, network: false, ...overrides });

/** 立项书已确认、使用中、带这个工具包的项目（维护者 pm-<n> 休眠） */
export function seedToolkitProject(daemon: Daemon, name: string, kit: PlanToolkit, overrides: Partial<Project> = {}): Project {
  return seedProject(daemon, name, { state: "in_use", charterConfirmed: true, kind: "other", toolkit: kit, ...overrides });
}
