// 安全和预算的两个开关（315 号票，config/safety-settings.ts、config.ts 的 writeFreshInstallDefaults / writeSafetyConfig）：
// 新装时写进配置文件（已写的键不碰）、设置里改了写回去（别的内容原样留着）、内存里的跟着换（任务的阈值里预算控制那一项现取）。
// 守护进程上的行为（守卫、预算核对按开关判）在主切面 test/main/fresh-install.test.ts。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FRESH_INSTALL_SAFETY, loadConfig, writeFreshInstallDefaults } from "../src/config/config.ts";
import { createSafetySettings, withLiveBudgetControl } from "../src/config/safety-settings.ts";
import { DEFAULT_TASK_THRESHOLDS } from "../src/tasks/thresholds.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const configFile = (dir: string) => path.join(dir, "config", "ergo.json");
const read = (dir: string) => JSON.parse(fs.readFileSync(configFile(dir), "utf8")) as unknown;

describe("新装时收紧的两项", () => {
  it("配置文件不在：新建一个只有这两项的；在、而且写了其中一项：只补没写的，别的原样", () => {
    const fresh = makeTempDir();
    fs.mkdirSync(path.join(fresh, "config"));
    expect(writeFreshInstallDefaults(configFile(fresh))).toEqual(["guard.conversationApprovals", "tasks.thresholds.budgetControl"]);
    expect(read(fresh)).toEqual({ guard: { conversationApprovals: "on" }, tasks: { thresholds: { budgetControl: true } } });
    expect(FRESH_INSTALL_SAFETY).toEqual({ conversationApprovals: "on", budgetControl: true });

    const written = makeTempDir();
    fs.mkdirSync(path.join(written, "config"));
    fs.writeFileSync(configFile(written), JSON.stringify({ ports: { local: 9000, external: 9001 }, guard: { conversationApprovals: "off" }, tasks: { maxRunning: 2, thresholds: { pullBacks: 4 } } }));
    expect(writeFreshInstallDefaults(configFile(written))).toEqual(["tasks.thresholds.budgetControl"]);
    expect(read(written)).toEqual({ ports: { local: 9000, external: 9001 }, guard: { conversationApprovals: "off" }, tasks: { maxRunning: 2, thresholds: { pullBacks: 4, budgetControl: true } } });
    // 都写过了：不动文件
    const before = fs.readFileSync(configFile(written), "utf8");
    expect(writeFreshInstallDefaults(configFile(written))).toEqual([]);
    expect(fs.readFileSync(configFile(written), "utf8")).toBe(before);
  });

  it("代码里的默认值没变：没写这两项的配置照旧是关着", () => {
    const dir = makeTempDir();
    const config = loadConfig({ env: { ERGO_DATA_DIR: dir }, homeDir: makeTempDir() });
    expect(config.guard.conversationApprovals).toBe("off");
    expect(config.tasks.thresholds.budgetControl).toBe(false);
  });
});

describe("设置里的两个开关", () => {
  it("改哪项给哪项：写回配置文件（别的原样）、内存里换掉、通知订阅方；任务的阈值里预算控制那一项现取", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(configFile(dir), JSON.stringify({ approvals: { waitMinutes: 3 }, tasks: { thresholds: { budgetControl: true } } }));
    const logs: string[] = [];
    const safety = createSafetySettings({ configFile: configFile(dir), initial: { conversationApprovals: "on", budgetControl: true }, log: (line) => logs.push(line) });
    const thresholds = withLiveBudgetControl({ ...DEFAULT_TASK_THRESHOLDS, budgetControl: true }, safety);
    let changes = 0;
    safety.onChange(() => changes++);
    expect(safety.view()).toEqual({ conversationApprovals: true, budgetControl: true });

    expect(safety.change({ budgetControl: false })).toEqual({ conversationApprovals: true, budgetControl: false });
    expect(thresholds.budgetControl).toBe(false);
    expect(thresholds.pullBacks).toBe(DEFAULT_TASK_THRESHOLDS.pullBacks);
    expect(read(dir)).toEqual({ approvals: { waitMinutes: 3 }, tasks: { thresholds: { budgetControl: false } }, guard: { conversationApprovals: "on" } });
    expect(safety.change({ conversationApprovals: false })).toEqual({ conversationApprovals: false, budgetControl: false });
    expect(safety.current()).toEqual({ conversationApprovals: "off", budgetControl: false });
    expect(read(dir)).toMatchObject({ guard: { conversationApprovals: "off" } });
    expect(changes).toBe(2);
    // 没变的不通知
    safety.change({ conversationApprovals: false });
    expect(changes).toBe(2);
    expect(logs).toHaveLength(2);
    // 写回的配置读得回来
    const config = loadConfig({ env: { ERGO_DATA_DIR: dir }, homeDir: makeTempDir() });
    expect([config.guard.conversationApprovals, config.tasks.thresholds.budgetControl, config.approvalWaitMs]).toEqual(["off", false, 3 * 60_000]);
  });
});
