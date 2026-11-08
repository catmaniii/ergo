// 主切面：体检后台盯着（416）接在真的守护进程上——临时数据目录、系统挑的端口、faux 模型、手动拨的时钟、服务管家是替身：
// - 秘书连着 5 轮模型出错（剧本是空的，像 DeepSeek 一直 503）、语音合成服务手工登记在服务管家里却连不上（本机 1 号端口，
//   不碰真的 8090）：体检里这两项坏了；拨过启动缓冲和几轮，后台盯着把它们放进待办（各一条，不重复）；
// - 服务管家用来判断要不要重启二狗的心跳（link 的 health）从头到尾都是 ok，网关的 /healthz 照旧 200、ok，里面只有秘书、插件、
//   网页文件这几样——模型、语音、备份这些不掺进去（DeepSeek 一忙二狗就被重启是最坏的结果，这里锁住）；
// - 体检接口带上后台盯着那一段；待办里点"不再提醒这件事"记住，体检页上"恢复提醒"拿掉；请求体不对回 400。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, DOCTOR_CORE_GROUP, DOCTOR_MUTE_ACTION, DOCTOR_OPEN_ACTION, type DoctorView, EVENT_TYPES, type NoticeInboxItem } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { DOCTOR_PROBLEM_NOTICE, WATCH_INTERVAL_MS, WATCH_STARTUP_GRACE_MS } from "../../src/doctor/watch.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { doctorApi } from "../helpers/http.ts";
import { type LinkMessage, startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { freePort } from "../helpers/ports.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const heartbeat = (m: LinkMessage) => m.type === "heartbeat";
const itemOf = (view: DoctorView, group: string, id: string) => view.groups.find((g) => g.id === group)?.items.find((item) => item.id === id);

/** 待办里"体检发现"的几条 */
const problems = (td: TestDaemon) => td.daemon.inbox.list().filter((item): item is NoticeInboxItem => item.kind === "notice" && item.notice === DOCTOR_PROBLEM_NOTICE);
const problemIds = (td: TestDaemon) =>
  problems(td)
    .map((item) => `${(item.data as { group: string }).group}/${(item.data as { id: string }).id}`)
    .toSorted();

/** 说一句，等秘书处理完（剧本是空的：这一轮模型出错） */
async function failTurn(frontend: TestFrontend, text: string): Promise<void> {
  const before = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;
  await frontend.sendText(text, { conversation: SECRETARY });
  await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length > before, { timeoutMs: 30_000, describe: () => `等秘书处理完「${text}」` });
}

describe("体检后台盯着（416）", () => {
  it("模型连着出错、语音合成停了：放进待办各一条；服务管家的心跳一直报 ok，/healthz 照旧 200、只看二狗自己", { timeout: 120_000 }, async () => {
    // 服务管家的数据目录是临时的：手写一条登记在 1 号端口上的语音合成（连不上），语音回复就算开着
    const svc = makeTempDir("ergo-watch-svc-");
    fs.mkdirSync(path.join(svc, "registry", "services"), { recursive: true });
    fs.writeFileSync(path.join(svc, "registry", "manager.yaml"), ["bind: 127.0.0.1", `port: ${await freePort()}`, ""].join("\n"));
    fs.writeFileSync(path.join(svc, "registry", "services", "my-tts.yaml"), ["id: my-tts", "name: 我的语音合成", "probe:", "  tier: health", "  port: 1", ""].join("\n"));
    const standIn = await startLsmStandIn({ heartbeatIntervalMs: 200 });
    onTestFinished(() => standIn.close());
    const clock = new ManualClock(Date.now());
    const td = await startTestDaemon({ clock, doctorWatch: true, secretary: [], env: { ERGO_SVC_PORT: "1", LSM_DATA_DIR: svc, DEEPSEEK_API_KEY: undefined, ...standIn.env } });
    await standIn.waitFor((m) => heartbeat(m) && m.health === "ok", "报健康的心跳");

    // 秘书连着 5 轮模型出错
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    for (let i = 1; i <= 5; i += 1) await failTurn(frontend, `第 ${i} 句`);
    const view = (await doctorApi.view(td.url)).body;
    expect(itemOf(view, DOCTOR_CORE_GROUP, "model-calls")?.level).toBe("error");
    // 437：语音插件起来的头一分钟探不通不作数（没查出来）；后台盯着头 5 分钟本来不查，过了这一分钟就照常是坏了
    expect(itemOf(view, "voice", "speech")?.level).toBe("unknown");
    // 体检接口带上后台盯着那一段：每 5 分钟、还没有不再提醒的
    expect(view.watch).toEqual({ everyMinutes: 5, muted: [] });

    // 启动缓冲之内不查
    clock.advance(WATCH_STARTUP_GRACE_MS - 60_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(problems(td)).toEqual([]);
    expect(itemOf((await doctorApi.view(td.url)).body, "voice", "speech")?.level).toBe("error");
    // 过了缓冲，一轮一轮地拨（每次拨完等这一轮查完：正在查的就等它，查完了再查一轮也一样）
    clock.advance(60_000);
    await td.daemon.doctorWatch.round();
    clock.advance(WATCH_INTERVAL_MS);
    await td.daemon.doctorWatch.round();
    clock.advance(WATCH_INTERVAL_MS);
    await td.daemon.doctorWatch.round();
    expect(problemIds(td)).toEqual([`${DOCTOR_CORE_GROUP}/model-calls`, "voice/speech"]);
    // 再查几轮也不重复放
    clock.advance(WATCH_INTERVAL_MS);
    await td.daemon.doctorWatch.round();
    expect(problems(td)).toHaveLength(2);
    const speech = problems(td).find((item) => (item.data as { id: string }).id === "speech")!;
    expect(speech).toMatchObject({ title: "语音合成坏了", source: "体检", actions: [DOCTOR_OPEN_ACTION, DOCTOR_MUTE_ACTION] });
    expect(speech.body).toContain("127.0.0.1:1");
    expect(speech.body).toContain("怎么修：");

    // 心跳：从连上到现在每一次都是 ok（等一次新的，确认放进待办之后也是）
    const from = standIn.messages.length;
    await standIn.waitFor(heartbeat, "放进待办之后的心跳", { from });
    const beats = standIn.messages.map((m) => m.message).filter(heartbeat);
    expect(beats.length).toBeGreaterThan(1);
    expect(beats.map((m) => m.health)).toEqual(beats.map(() => "ok"));
    // /healthz：200、ok，只有这几样（秘书、插件、网页文件），没有体检、模型、语音
    const res = await fetch(`${td.url}/healthz`);
    expect(res.status).toBe(200);
    const health = (await res.json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, status: "ok", reasons: [] });
    expect(Object.keys(health).toSorted()).toEqual(["ok", "plugins", "reasons", "secretary", "status", "webUi"]);

    // 待办里点"不再提醒这件事"：体检接口里列出来；体检页上"恢复提醒"拿掉；请求体不对回 400
    td.daemon.inbox.act({ itemIds: [speech.id], action: "handle", choice: DOCTOR_MUTE_ACTION, idempotencyKey: "mute-1" });
    expect((await doctorApi.view(td.url)).body.watch?.muted).toEqual([{ group: "voice", id: "speech", title: "语音合成", at: expect.any(String) }]);
    expect(JSON.parse(fs.readFileSync(path.join(td.dataDir, "config", "doctor-watch.json"), "utf8"))).toMatchObject({ muted: [{ group: "voice", id: "speech" }] });
    const bad = await doctorApi.unmute(td.url, { group: "voice" });
    expect(bad.status).toBe(400);
    const unmuted = await doctorApi.unmute(td.url, { group: "voice", id: "speech" });
    expect(unmuted).toMatchObject({ status: 200, body: { everyMinutes: 5, muted: [] } });
    // 恢复了、还是坏的：下一轮照常放一条新的
    clock.advance(WATCH_INTERVAL_MS);
    await td.daemon.doctorWatch.round();
    expect(problems(td).filter((item) => (item.data as { id: string }).id === "speech" && item.handled === undefined)).toHaveLength(1);
  });
});
