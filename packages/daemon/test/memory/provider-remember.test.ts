// 337 号票第二段：秘书的"记一句"工具 → 记忆插件槽的宿主 → 会意插件 → 真的落进记忆；彻底删除这条会话时能删掉。
// 用临时目录里的真守护进程（临时数据目录、假向量、假模型；不碰真的 ~/.ergo，不起服务管家）。
// 这一份测的是工具背后的那条链（不经过模型）：工具本身、宿主的 remember、会意写的"显式记忆命令"素材和推理库里的证据；
// 秘书在会话里真的调这个工具是 test/main/memory-remember.test.ts 的事。
import { CHANNELS, EVENT_TYPES, type MemoryCommandEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MATERIALS_CHANNEL } from "../../src/materials/index.ts";
import { rememberTool } from "../../src/memory/provider/tool.ts";
import { REMEMBER_VIA } from "../../src/memory/provider/subtext-runtime.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;

/** 用户说的那句（中性假名，别用真名） */
const SAID = "周四晚上和小林约了在体育馆打羽毛球";

/** 起来一个守护进程、发一句话拿到它的消息编号（和秘书真的处理一轮） */
async function daemonWithMessage() {
  const td = await startTestDaemon({ secretary: [{ kind: "reply", text: "好" }] });
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [SECRETARY]: 0 });
  const sent = await frontend.sendText(`帮我记一句：${SAID}`);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
  await frontend.close();
  const tool = rememberTool({ remember: (input) => td.daemon.memoryHost.remember(input), store: td.daemon.store });
  return { td, tool, inputMessageId: sent.messageId };
}

const commandsOf = (td: Awaited<ReturnType<typeof daemonWithMessage>>["td"]) =>
  td.daemon.store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand).map((event) => event.payload as MemoryCommandEventPayload);

describe("记一句：经工具落到记忆里", () => {
  it("交给宿主一条带会话、消息、工具调用的出处；真的进了记忆（检索找得到，带着那条消息的出处）", { timeout: 60_000 }, async () => {
    const { td, tool, inputMessageId } = await daemonWithMessage();
    try {
      const out = await tool.run({ text: SAID }, { toolCallId: "call-remember", inputMessageId, agentId: SECRETARY });
      expect(out.isError).toBeUndefined();
      expect(out.text).toContain("记下了");

      // 事件日志里是一条"从秘书那里来"的记住命令：没有卡片，带着会话、消息、工具调用
      const [command] = commandsOf(td);
      expect(command).toMatchObject({ command: "remember", content: SAID, source: "typed" });
      expect(command!.command === "remember" ? command!.from : undefined).toMatchObject({ kind: "secretary", conversation: SECRETARY, inputMessageId, toolCallId: "call-remember" });
      // 素材：显式记忆命令那条，落在秘书的会话里、出处记着那句话来自哪条消息
      const material = td.daemon.materials.list({ conversation: SECRETARY }).find((m) => m.kind === "memory_command");
      expect(material).toBeDefined();
      expect(material!.ref.messageId).toBe(inputMessageId);
      expect(material!.segments.map((s) => s.text)).toEqual([SAID]);

      // 检索找得到：原话一字不改，出处是素材 + 那条消息
      const found = await td.daemon.memoryHost.search({ text: SAID });
      const hit = found.items.find((item) => item.text === SAID);
      expect(hit).toBeDefined();
      expect(hit!.sources).toContainEqual({ kind: "material", id: material!.id });
      expect(hit!.sources).toContainEqual({ kind: "message", id: inputMessageId });

      // 同一句话再记一次：不落第二条命令（幂等键），记忆还是一条
      await tool.run({ text: SAID }, { toolCallId: "call-remember", inputMessageId, agentId: SECRETARY });
      expect(commandsOf(td)).toHaveLength(1);
      expect((await td.daemon.memoryHost.search({ text: SAID })).items.filter((item) => item.text === SAID)).toHaveLength(1);
    } finally {
      await td.daemon.stop();
    }
  });

  it("彻底删除这条会话：素材和推理库里那条一起删掉，检索找不到了；记住的命令事件只换掉内容", { timeout: 60_000 }, async () => {
    const { td, tool, inputMessageId } = await daemonWithMessage();
    try {
      const out = await tool.run({ text: SAID }, { toolCallId: "call-remember", inputMessageId, agentId: SECRETARY });
      expect(out.isError).toBeUndefined();
      expect((await td.daemon.memoryHost.search({ text: SAID })).items.length).toBeGreaterThan(0);

      // 设置里按会话彻底删除（和用户在设置里选这个会话一样，走现成的批量删除）
      const purged = await materialsApi.delete(td.url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-remember" });
      expect(purged.status).toBe(200);

      // 记忆里没了
      expect((await td.daemon.memoryHost.search({ text: SAID })).items).toEqual([]);
      // 素材库里没了（命令本身那条还在：它是"这些删了"的记录）
      expect(td.daemon.materials.list().some((m) => m.segments.some((s) => s.text === SAID))).toBe(false);
      // "记住"的命令事件只换掉内容，命令 id、来源、出处不变
      const remember = commandsOf(td).find((command) => command.command === "remember");
      expect(remember).toBeDefined();
      expect(remember!.command === "remember" ? remember!.content : undefined).not.toContain(SAID);
      expect(remember!.command === "remember" ? remember!.from : undefined).toMatchObject({ kind: "secretary", conversation: SECRETARY, toolCallId: "call-remember" });
    } finally {
      await td.daemon.stop();
    }
  });

  it("记忆插件没起来时，工具如实回没记成（不抛、不假装记下了）", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({});
    try {
      const tool = rememberTool({
        remember: async () => {
          throw new Error("现在没有在跑的记忆插件：先在配置里选一个启用");
        },
        store: td.daemon.store,
      });
      const out = await tool.run({ text: SAID }, { toolCallId: "call-remember" });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("没记成");
      expect(out.text).toContain("没有在跑的记忆插件");
    } finally {
      await td.daemon.stop();
    }
  });
});

/** 337 号票：写推理库时留痕写的"经谁转达"（这个常量给测试认，别改成别处去） */
describe("记一句的留痕", () => {
  it("写推理库那一笔记的是用户发起、经秘书记一句", () => {
    expect(REMEMBER_VIA).toBe("经秘书记一句");
  });
});
