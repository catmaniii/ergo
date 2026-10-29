// 语音插件：说话的是哪个 agent、它现在用哪个参考音色（248 号票；241 号票起是每个 agent 自己配的，现在从角色来）。
// 从会话认 agent（秘书的主线、维护者的会话），再按它那个角色指定的音色取参考音色；没指定、那个被删了、语音插件刚停用，
// 都回退到全局选中的那一个（31 号票）——一个参考音色都没有时 undefined（这次不用语音）。
import { CHANNELS, maintainerChannel } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { agentIdOfConversation, voiceOfAgent, type VoiceLookup } from "../../src/voice/agent-voice-ref.ts";

const voice = (id: string) => ({ id, name: `音色 ${id}`, referenceText: "示例", durationMs: 3000, sha256: "", importedAt: "", audioPath: `C:\\voices\\${id}\\reference.wav` });

/** 参考音色：有的这几个，全局默认是 currentId（没选过、选的那个被删了就是最早导入的） */
function voices(existing: readonly string[], currentId?: string): VoiceLookup {
  const all = existing.map(voice);
  return { get: (id) => all.find((v) => v.id === id), current: () => all.find((v) => v.id === currentId) ?? all[0] };
}

/** agent 那个角色指定的音色的 id（跟默认、默认角色是 undefined） */
const roles = (own: Record<string, string>) => ({ voiceIdOf: (agentId: string) => own[agentId] });

describe("说话的是哪个 agent", () => {
  it("秘书的主线、维护者的会话认得出；别的（不该发生）没有", () => {
    expect(agentIdOfConversation(CHANNELS.secretary)).toBe("secretary");
    expect(agentIdOfConversation(maintainerChannel("pm-1"))).toBe("pm-1");
    expect(agentIdOfConversation(maintainerChannel("tm-3"))).toBe("tm-3");
    expect(agentIdOfConversation("somewhere-else")).toBeUndefined();
  });
});

describe("这个 agent 用哪个参考音色", () => {
  it("角色指定了、那个音色还在：用它指定的", () => {
    expect(voiceOfAgent("pm-1", { roles: roles({ "pm-1": "v-2" }), voices: voices(["v-1", "v-2"], "v-1") })).toMatchObject({ id: "v-2" });
  });

  it("角色没指定音色：跟全局默认（31 号票选中的那个）", () => {
    expect(voiceOfAgent("pm-1", { roles: roles({}), voices: voices(["v-1", "v-2"], "v-2") })).toMatchObject({ id: "v-2" });
    // 一个都没选过：最早导入的
    expect(voiceOfAgent("pm-1", { roles: roles({}), voices: voices(["v-1", "v-2"]) })).toMatchObject({ id: "v-1" });
  });

  it("角色指定的那个被删了：回退全局默认，不是报错", () => {
    expect(voiceOfAgent("pm-1", { roles: roles({ "pm-1": "v-9" }), voices: voices(["v-1"], "v-1") })).toMatchObject({ id: "v-1" });
  });

  it("语音插件没有参考音色、没接到角色：都不炸，回 undefined（这次不用语音）", () => {
    expect(voiceOfAgent("pm-1", { roles: roles({ "pm-1": "v-2" }), voices: voices([]) })).toBeUndefined();
    expect(voiceOfAgent("pm-1", { voices: voices(["v-1"], "v-1") })).toMatchObject({ id: "v-1" });
    expect(voiceOfAgent(undefined, { roles: roles({ secretary: "v-1" }), voices: voices(["v-1"], "v-1") })).toMatchObject({ id: "v-1" });
  });
});
