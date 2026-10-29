// 主切面：首次设置向导的两条接口（319 号票）——GET /api/setup 看五步各自做完了没有，POST /api/setup 标
// "以后再说"（skip: true）或者"看过了/做完了"。各步的 ready 是组合根注入的现算取值：
// 我的名字（userName.current()）、模型的 key（modelSettings.keyView()）、记忆的向量模型那个组件（components.view() 的功能门）、
// 已配对的设备（pairing.list()）；safety 没有条件，只有看过了才算 done。
// 都在临时目录、系统挑的空闲端口上（不碰真的 ~/.ergo），条件用真的服务造（设了我的名字、写错请求体），不碰真的设备。
import fs from "node:fs";
import { SETUP_STEPS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { setupApi, userNameApi } from "../helpers/http.ts";

const configOf = (dataDir: string) => JSON.parse(fs.readFileSync(dataDirLayout(dataDir).configFile, "utf8")) as Record<string, unknown>;

describe("首次设置向导的接口（319 号票）", () => {
  it("GET /api/setup：五步都还没做；条件满足的那步自己算 ready 和 done（设了我的名字）；标'以后再说'的 done 但 ready 不变，写回配置文件", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ fresh: true, env: { DEEPSEEK_API_KEY: undefined } });
    const fresh = await setupApi.view(td.url);
    expect(fresh.status).toBe(200);
    expect(fresh.body.steps.map((step) => step.id)).toEqual([...SETUP_STEPS]);
    expect(fresh.body.steps.every((step) => !step.ready && !step.done)).toBe(true);
    expect(fresh.body.steps.every((step) => step.optional)).toBe(true);
    expect(fresh.body.complete).toBe(false);

    // 在我的名字那一步填了名字：language 自己变成 ready + done，不用打标记
    expect((await userNameApi.change(td.url, "小明")).status).toBe(200);
    const named = await setupApi.view(td.url);
    expect(named.body.steps.find((step) => step.id === "language")).toEqual({ id: "language", done: true, ready: true, optional: true });
    expect(named.body.complete).toBe(false);

    // 安全默认值说明那一步没有条件：用户点了"看过了"才算 done
    const marked = await setupApi.mark(td.url, { step: "safety" });
    expect(marked.status).toBe(200);
    expect(marked.body.steps.find((step) => step.id === "safety")).toEqual({ id: "safety", done: true, ready: false, optional: true });
    expect((await setupApi.view(td.url)).body).toEqual(marked.body);
    // 标了"以后再说"：done 变 true、ready 还是 false
    const skipped = await setupApi.mark(td.url, { step: "phone", skip: true });
    expect(skipped.body.steps.find((step) => step.id === "phone")).toEqual({ id: "phone", done: true, ready: false, optional: true });
    // 真相是配置文件：别的字段（新装时写进去的两项）原样留着
    expect(configOf(td.dataDir)).toMatchObject({ setup: { format: 1, skipped: ["phone"], done: ["safety"] } });
    expect(configOf(td.dataDir)).toHaveProperty("guard.conversationApprovals");
  });

  it("POST /api/setup：step 不是五步之一、多了字段都回 400；'看过了'把'以后再说'改回来（一步只待在一处）", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ fresh: true, env: { DEEPSEEK_API_KEY: undefined } });
    const bad = await setupApi.mark(td.url, { step: "不是一步" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("设置向导打标记的参数不对");
    expect((await setupApi.mark(td.url, { step: "language", extra: true })).status).toBe(400);
    expect((await setupApi.mark(td.url, {})).status).toBe(400);
    // 拒收的请求什么都没写
    expect(configOf(td.dataDir).setup).toBeUndefined();

    expect((await setupApi.mark(td.url, { step: "model", skip: true })).body.steps.find((step) => step.id === "model")?.done).toBe(true);
    const done = await setupApi.mark(td.url, { step: "model" });
    expect(done.status).toBe(200);
    expect(done.body.steps.find((step) => step.id === "model")).toEqual({ id: "model", done: true, ready: false, optional: true });
    expect(configOf(td.dataDir)).toMatchObject({ setup: { format: 1, skipped: [], done: ["model"] } });
  });
});
