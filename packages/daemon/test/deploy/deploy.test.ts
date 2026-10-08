// 公网入口的部署（规格第 6 节、第 21 节）：部署是一次 ssh 上 VPS 的动作，由用户在本机运行部署命令完成，运行即确认。
// 守护进程和任何 agent 都不会自己发起部署。ssh 换成可替换的执行器测，不连真的 VPS。
// 另外核对仓库里 LSM 条目的示例：ergou-tunnel 只连守护进程的外网端口；ergou-daemon 的公网入口段默认注释掉。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORTS } from "../../src/config/config.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { type CommandExecutor, runDeployCommand } from "../../src/deploy/deploy.ts";
import { nginxSiteConfig } from "../../src/deploy/nginx.ts";
import { DEFAULT_TUNNEL_PORT, publicAccessDefaults } from "../../src/deploy/public-access.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const daemonSrc = path.join(repoRoot, "packages/daemon/src");

const PUBLIC_ACCESS = { vpsHost: "203.0.113.10", sshUser: "root", sshKey: "C:\\keys\\vps.pem" };

/** 临时数据目录，配置文件里写上 publicAccess（不给就不写） */
function dataDirWith(config: Record<string, unknown>): string {
  const dataDir = makeTempDir("ergou-data-");
  const layout = dataDirLayout(dataDir);
  fs.mkdirSync(layout.config, { recursive: true });
  fs.writeFileSync(layout.configFile, JSON.stringify(config));
  return dataDir;
}

/** 假的执行器：记下每次调用，按给定的退出码返回 */
function fakeExecutor(status = 0) {
  const calls: Array<{ argv: readonly string[]; stdin: string }> = [];
  const exec: CommandExecutor = async (argv, stdin) => {
    calls.push({ argv, stdin });
    return { status };
  };
  return { exec, calls };
}

async function run(dataDir: string, argv: string[] = [], status = 0) {
  const { exec, calls } = fakeExecutor(status);
  const out: string[] = [];
  const code = await runDeployCommand({ argv, env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir("ergou-home-"), exec, log: (line) => out.push(line) });
  return { code, calls, out: out.join("\n") };
}

describe("部署命令", () => {
  it("用户在本机运行：执行一次 ssh，把生成的站点配置交给 VPS 上的脚本（先 nginx -t，通过了才 reload）", async () => {
    const { code, calls, out } = await run(dataDirWith({ publicAccess: PUBLIC_ACCESS }));
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const [{ argv, stdin }] = calls as [(typeof calls)[number]];
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("BatchMode=yes");
    expect(argv.slice(argv.indexOf("-i"), argv.indexOf("-i") + 2)).toEqual(["-i", "C:\\keys\\vps.pem"]);
    expect(argv.slice(-2)).toEqual(["root@203.0.113.10", "sh -s"]);
    // 脚本和配置都从 stdin 送过去：配置原样在里面
    const config = nginxSiteConfig(publicAccessDefaults(PUBLIC_ACCESS));
    expect(stdin).toContain(config);
    expect(stdin).toContain("/etc/nginx/sites-available/ergou.conf");
    expect(stdin).toContain("ln -sf /etc/nginx/sites-available/ergou.conf /etc/nginx/sites-enabled/ergou.conf");
    const test = stdin.indexOf("nginx -t");
    const reload = stdin.indexOf("systemctl reload nginx");
    expect(test).toBeGreaterThan(stdin.indexOf(config));
    expect(reload).toBeGreaterThan(test);
    expect(out).toContain("https://ergou.203.0.113.10.sslip.io");
  });

  it("--print：只打印生成的配置，不 ssh", async () => {
    const { code, calls, out } = await run(dataDirWith({ publicAccess: PUBLIC_ACCESS }), ["--print"]);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(out).toContain(nginxSiteConfig(publicAccessDefaults(PUBLIC_ACCESS)));
  });

  it("ssh 或 VPS 上的脚本失败（比如 nginx -t 没通过）：以非零退出，说明原因", async () => {
    const { code, calls, out } = await run(dataDirWith({ publicAccess: PUBLIC_ACCESS }), [], 1);
    expect(calls).toHaveLength(1);
    expect(code).not.toBe(0);
    expect(out).toContain("部署没有完成");
  });

  it("配置里没有 publicAccess、还是占位符、写法不对：不 ssh，说明是哪一项", async () => {
    const missing = await run(dataDirWith({ ports: { local: 8810, external: 8811 } }));
    expect(missing.code).not.toBe(0);
    expect(missing.calls).toEqual([]);
    expect(missing.out).toContain("publicAccess");

    // 仓库里的示例配置原样放进去：都是占位符，不能部署
    const example = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergou.example.json"), "utf8")) as Record<string, unknown>;
    const placeholder = await run(dataDirWith(example));
    expect(placeholder.calls).toEqual([]);
    expect(placeholder.out).toContain("占位符");

    // 会被写进 nginx 配置和远端脚本的值，字符集不对的一律不收
    const injected = await run(dataDirWith({ publicAccess: { ...PUBLIC_ACCESS, vpsHost: "203.0.113.10; rm -rf /" } }));
    expect(injected.calls).toEqual([]);
    expect(injected.out).toContain("publicAccess.vpsHost");
  });

  it("守护进程和任何 agent 都不会自己发起部署：部署模块只被部署命令的入口引用，别处不起 ssh", () => {
    const files = fs
      .readdirSync(daemonSrc, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => path.relative(daemonSrc, path.join(e.parentPath, e.name)).replaceAll("\\", "/"));
    const importsDeploy = files.filter((f) => !f.startsWith("deploy/") && /from\s+["'][^"']*\/deploy\/deploy\.ts["']/.test(fs.readFileSync(path.join(daemonSrc, f), "utf8")));
    expect(importsDeploy).toEqual(["deploy-nginx.ts"]);
    const spawnsSsh = files.filter((f) => /["']ssh["']/.test(fs.readFileSync(path.join(daemonSrc, f), "utf8")));
    expect(spawnsSsh).toEqual(["deploy/deploy.ts"]);
  });
});

describe("ergou-tunnel 的 LSM 条目", () => {
  const entry = fs.readFileSync(path.join(repoRoot, "deploy/lsm/ergou-tunnel.example.yaml"), "utf8");
  const code = entry.replace(/#[^\n]*/g, "");

  it("存在，目标是守护进程的外网端口：ssh -R 只绑 VPS 的本机地址，隧道端口和 nginx 的上游一致", () => {
    expect(code).toMatch(/^id: ergou-tunnel$/m);
    const forward = `127.0.0.1:${DEFAULT_TUNNEL_PORT}:127.0.0.1:${DEFAULT_PORTS.external}`;
    const argv = [...code.matchAll(/^\s+- (.+)$/gm)].map((m) => m[1]!.trim());
    expect(argv[0]).toBe("ssh");
    expect(argv[argv.indexOf("-R") + 1]).toBe(forward);
    // 不连本机端口
    expect(code).not.toContain(`:${DEFAULT_PORTS.local}`);
    // LSM 按命令行认隧道进程
    const matchCmd = /matchCmd: (.+)$/m.exec(code)?.[1]?.trim();
    expect(matchCmd).toBeDefined();
    expect(new RegExp(matchCmd!).test(argv.join(" "))).toBe(true);
    expect(code).toMatch(/autoRestart:\s*\n\s+enabled: true/);
  });

  it("只有占位符：没有真实的 VPS 地址、私钥路径", () => {
    expect(entry).toContain("<VPS 地址>");
    expect(entry).toContain("<ssh 私钥路径>");
    const ips = [...entry.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0]);
    expect(ips.filter((ip) => ip !== "127.0.0.1")).toEqual([]);
    expect(entry).not.toMatch(/\.pem\b/);
  });
});

describe("ergou-daemon 的 LSM 条目", () => {
  const entry = fs.readFileSync(path.join(repoRoot, "deploy/lsm/ergou-daemon.example.yaml"), "utf8").replaceAll("\r\n", "\n");
  const code = entry.replace(/#[^\n]*/g, "");

  it("接入 link 协议（23 号票）：探活档位 linked（接入层断了降级回 /healthz）、启动时注入身份、开着 autoRestart；stop 钩子留作接入层断开时的兜底", () => {
    expect(code).toMatch(/^probe:\n\s+tier: linked\n\s+port: 8810\n\s+health:\n\s+url: http:\/\/127\.0\.0\.1:8810\/healthz\n/m);
    expect(code).toMatch(/^link:\n\s+enabled: true\s*\n/m);
    expect(code).toMatch(/^autoRestart:\n\s+enabled: true\n/m);
    expect(code).toMatch(/^\s+stop:\n\s+argv:\n\s+- <专用 Node 路径>\n\s+- packages\/daemon\/src\/stop\.ts\n/m);
  });

  it("对 audiocpp（本机 LSM 托管的语音合成服务）是弱依赖（32 号票）：不等它就绪，它没开时语音回复退回只发文字", () => {
    expect(code).toMatch(/^dependsOn:\n\s+- id: audiocpp\n\s+type: soft\s*\n/m);
  });

  it("公网入口（exposure）只是注释掉的示例：隧道还没登记时照抄这份登记，不会因为 via 指向不存在的服务而登记不上", () => {
    expect(code).not.toMatch(/^exposure:/m);
    expect(code).not.toContain("ergou-tunnel");
    expect(entry).toMatch(/^# exposure:\n#\s+via: ergou-tunnel\n#\s+remotePort: 18811\n/m);
  });
});
