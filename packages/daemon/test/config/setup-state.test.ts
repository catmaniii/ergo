// 首次设置向导（319 号票，config/setup-state.ts、config.ts 的 parseSetup / writeSetupConfig）：
// - 五步各自的 ready（条件现在满不满足）由注入的取值函数现算，done = ready || 点了"以后再说" || 点了"做完了"；
// - "以后再说"和"做完了"一步只待在一处，标了一边就从另一边去掉；
// - 真相是配置文件的 setup 节：写回去时别的字段原样留着；没有这一节的旧配置、手改坏了的都不炸，按"什么都没做"。
// - 老数据目录（347 号票）：format 1 当时已经走完的算能力看过了，引导条不回来；新数据目录要看过能力才算完。
// 守护进程上的行为（各步的 ready 从哪个服务取）在主切面 test/main/setup.test.ts。
import fs from "node:fs";
import path from "node:path";
import { SETUP_STEPS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.ts";
import { createSetupState, type SetupReadyProbes } from "../../src/config/setup-state.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const configFile = (dir: string) => path.join(dir, "config", "ergo.json");
const read = (dir: string) => JSON.parse(fs.readFileSync(configFile(dir), "utf8")) as Record<string, unknown>;
/** 数据目录里先写好一份配置（别的字段照旧留着，看写回去有没有动它） */
function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(configFile(dir), JSON.stringify(config));
}

/** 测试里的几步条件：默认都不满足，给了哪步满足哪步；vector：记忆的向量模型那个组件好了（只有算老数据目录时看） */
type On = Partial<Record<keyof SetupReadyProbes | "vector", boolean>>;
function probes(on: On = {}): SetupReadyProbes {
  return {
    language: () => on.language === true,
    model: () => on.model === true,
    phone: () => on.phone === true,
  };
}

/** 从一份配置起这个服务（和组合根一样：initial 取 loadConfig 读到的） */
function open(dir: string, on: On = {}, logs: string[] = []) {
  const config = loadConfig({ env: { ERGO_DATA_DIR: dir }, homeDir: makeTempDir() });
  return createSetupState({ configFile: configFile(dir), initial: config.setup, ready: probes(on), legacyComponentsReady: () => on.vector === true, log: (line) => logs.push(line) });
}

/** view 里五步的 id → { ready, done }，断言时短一点 */
const stateOf = (view: ReturnType<ReturnType<typeof open>["view"]>) => Object.fromEntries(view.steps.map((step) => [step.id, { ready: step.ready, done: step.done }]));

describe("首次设置向导的标记", () => {
  it("什么都没配：五步都 ready、done 都是 false，不算做完；步骤的先后就是协议里的五步", () => {
    const dir = makeTempDir();
    const setup = open(dir);
    const view = setup.view();
    expect(view.steps.map((step) => step.id)).toEqual([...SETUP_STEPS]);
    expect(view.steps.every((step) => step.optional)).toBe(true);
    expect(stateOf(view)).toEqual(Object.fromEntries(SETUP_STEPS.map((id) => [id, { ready: false, done: false }])));
    expect(view.complete).toBe(false);
    expect(setup.current()).toEqual({ format: 2, skipped: [], done: [] });
  });

  it("条件满足的步骤自己就是 done（不用点）：比如填了我的名字、配了模型的 key", () => {
    const setup = open(makeTempDir(), { language: true, model: true });
    expect(stateOf(setup.view())).toEqual({
      language: { ready: true, done: true },
      model: { ready: true, done: true },
      capabilities: { ready: false, done: false },
      phone: { ready: false, done: false },
      safety: { ready: false, done: false },
    });
    expect(setup.view().complete).toBe(false);
  });

  it("点'以后再说'：done 变 true、ready 不变，写进配置文件的 skipped；再点'做完了'：skipped 里去掉、done 里有了", () => {
    const dir = makeTempDir();
    writeConfig(dir, { ports: { local: 9000, external: 9001 } });
    const logs: string[] = [];
    const setup = open(dir, {}, logs);
    // 模型的 key 没配，但用户点了"以后再说"
    expect(setup.mark({ step: "model", skip: true }).steps.find((step) => step.id === "model")).toEqual({ id: "model", done: true, ready: false, optional: true });
    expect(setup.current()).toEqual({ format: 2, skipped: ["model"], done: [] });
    expect(read(dir)).toEqual({ ports: { local: 9000, external: 9001 }, setup: { format: 2, skipped: ["model"], done: [] } });
    // 再点"做完了"：从 skipped 里去掉，写进 done
    expect(setup.mark({ step: "model" }).steps.find((step) => step.id === "model")).toEqual({ id: "model", done: true, ready: false, optional: true });
    expect(setup.current()).toEqual({ format: 2, skipped: [], done: ["model"] });
    expect(read(dir)).toMatchObject({ setup: { format: 2, skipped: [], done: ["model"] } });
    // 写回的标记读得回来；每次只记一句日志
    expect(open(dir).current()).toEqual({ format: 2, skipped: [], done: ["model"] });
    expect(logs).toHaveLength(2);
  });

  it("safety 没有条件：只有看过（或者点了'以后再说'）才算 done；五步都打完是 complete", () => {
    const setup = open(makeTempDir());
    expect(setup.view().steps.find((step) => step.id === "safety")).toEqual({ id: "safety", done: false, ready: false, optional: true });
    setup.mark({ step: "safety" });
    expect(setup.view().steps.find((step) => step.id === "safety")).toEqual({ id: "safety", done: true, ready: false, optional: true });
    expect(setup.view().complete).toBe(false);
    // 另外四步"以后再说"就都算做完
    for (const step of ["language", "model", "capabilities", "phone"] as const) setup.mark({ step, skip: true });
    expect(setup.view().steps.filter((step) => !step.done)).toEqual([]);
    expect(setup.view().complete).toBe(true);
    expect(setup.current()).toEqual({ format: 2, skipped: ["language", "model", "capabilities", "phone"], done: ["safety"] });
  });

  it("没有 setup 节的旧配置、手改坏了的都不炸：按什么都没做（认得的那几步照算）", () => {
    const old = makeTempDir();
    writeConfig(old, { ports: { local: 9000, external: 9001 } });
    expect(open(old).current()).toEqual({ format: 2, skipped: [], done: [] });
    expect(open(old).view().complete).toBe(false);

    const broken = makeTempDir();
    writeConfig(broken, { setup: { format: 1, skipped: "model", done: [42, "phone", "不是一步", "phone"] } });
    expect(open(broken).current()).toEqual({ format: 2, skipped: [], done: ["phone"] });
    expect(open(broken).view().steps.find((step) => step.id === "phone")).toEqual({ id: "phone", done: true, ready: false, optional: true });

    const notObject = makeTempDir();
    writeConfig(notObject, { setup: ["model"] });
    expect(open(notObject).current()).toEqual({ format: 2, skipped: [], done: [] });
  });

  it("写回去的时候别的字段还在（配置里的其它节、setup 里多出来的字段都不动）", () => {
    const dir = makeTempDir();
    writeConfig(dir, { approvals: { waitMinutes: 3 }, guard: { conversationApprovals: "on" }, setup: { format: 1, skipped: [], done: [], note: "手写的" } });
    const setup = open(dir);
    setup.mark({ step: "phone", skip: true });
    expect(read(dir)).toEqual({
      approvals: { waitMinutes: 3 },
      guard: { conversationApprovals: "on" },
      setup: { format: 2, skipped: ["phone"], done: [], note: "手写的" },
    });
  });
});

// 347 号票：第③步从"组件"换成"能力"。以前走完向导的不再看到引导条，新用户要看过这一步才算完
describe("老数据目录和新数据目录", () => {
  const capabilities = (setup: ReturnType<typeof open>) => setup.view().steps.find((step) => step.id === "capabilities");
  /** 这一版之前写的配置 */
  const oldConfig = (skipped: string[], done: string[]) => ({ ports: { local: 9000, external: 9001 }, setup: { format: 1, skipped, done } });

  it("老数据目录当时走完了（第③步点过以后再说）：算能力看过了，complete 是 true；写回配置，重启还是", () => {
    const dir = makeTempDir();
    writeConfig(dir, oldConfig(["phone", "components"], ["safety"]));
    const logs: string[] = [];
    const setup = open(dir, { language: true, model: true }, logs);
    expect(setup.view().complete).toBe(true);
    expect(capabilities(setup)).toEqual({ id: "capabilities", done: true, ready: false, optional: true });
    expect(read(dir)).toEqual({ ports: { local: 9000, external: 9001 }, setup: { format: 2, skipped: ["phone"], done: ["safety", "capabilities"] } });
    expect(logs).toHaveLength(1);

    const again = open(dir, { language: true, model: true }, logs);
    expect(again.view().complete).toBe(true);
    expect(logs).toHaveLength(1);
  });

  it("老数据目录第③步没打过标记、向量模型装好了（当时条件满足）：也算走完", () => {
    const dir = makeTempDir();
    writeConfig(dir, oldConfig([], ["safety", "language", "model", "phone"]));
    expect(open(dir, { vector: true }).view().complete).toBe(true);
  });

  it("老数据目录当时没走完（向量模型没装也没标记、safety 没看）：能力照样要看；只算一次，后来条件满足了也不补", () => {
    const noVector = makeTempDir();
    writeConfig(noVector, oldConfig([], ["safety", "language", "model", "phone"]));
    const setup = open(noVector);
    expect(capabilities(setup)?.done).toBe(false);
    expect(setup.view().complete).toBe(false);
    expect(read(noVector)).toEqual({ ports: { local: 9000, external: 9001 }, setup: { format: 2, skipped: [], done: ["safety", "language", "model", "phone"] } });
    // 升级以后才装好向量模型：这时候是新算法，能力还是要看
    expect(capabilities(open(noVector, { vector: true }))?.done).toBe(false);

    const noSafety = makeTempDir();
    writeConfig(noSafety, oldConfig(["phone", "components"], []));
    expect(capabilities(open(noSafety, { language: true, model: true }))?.done).toBe(false);
  });

  it("新数据目录：向量模型早装好了、别的都做完，能力还是没做完，看过才算；重启也不会被当成老数据目录", () => {
    const dir = makeTempDir();
    const on = { language: true, model: true, phone: true, vector: true };
    const setup = open(dir, on);
    expect(setup.view().steps.filter((step) => !step.done).map((step) => step.id)).toEqual(["capabilities", "safety"]);
    setup.mark({ step: "safety" });
    expect(capabilities(setup)?.done).toBe(false);
    expect(setup.view().complete).toBe(false);

    // 重启：写的是 format 2，不按老的算
    const again = open(dir, on);
    expect(capabilities(again)?.done).toBe(false);
    expect(again.view().complete).toBe(false);

    again.mark({ step: "capabilities" });
    expect(again.view().complete).toBe(true);
    expect(read(dir)).toEqual({ setup: { format: 2, skipped: [], done: ["safety", "capabilities"] } });
  });

  it("老数据目录没走完、在这一版接着走：能力要看过", () => {
    const dir = makeTempDir();
    writeConfig(dir, oldConfig(["components"], ["language", "model"]));
    const on = { phone: true };
    const setup = open(dir, on);
    setup.mark({ step: "safety" });
    expect(capabilities(setup)?.done).toBe(false);
    expect(capabilities(open(dir, on))?.done).toBe(false);
  });

  it("结果写不进配置文件：这次照样算走完，记一行日志，不拦着起来", () => {
    const logs: string[] = [];
    const setup = createSetupState({
      // 目录当文件，读写都失败
      configFile: makeTempDir(),
      initial: { format: 1, skipped: [], done: ["safety"], legacyComponentsMarked: true },
      ready: probes({ language: true, model: true, phone: true }),
      legacyComponentsReady: () => false,
      log: (line) => logs.push(line),
    });
    expect(setup.view().complete).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("没写进配置文件");
  });
});
