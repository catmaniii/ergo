// 前端状态层：角色（248 号票）——秘书指定的角色优先于全局的名字（43 号票），
// 名字和音色写成话（"现在：文翰（指定的角色）"）、"跟随默认（<默认角色的名字>）"、改名边打边查、谁在用写成人话。
import { describe, expect, test } from "vitest";
import {
  type AgentIdentityView,
  type AgentRolesView,
  ASSISTANT_NAME_MARK,
  agentIdentityLine,
  agentIdentityOf,
  agentLabelText,
  agentNameNote,
  agentVoiceNote,
  assistantNameOf,
  canCreateRoleName,
  canSaveRoleName,
  CHANNELS,
  defaultVoiceOptionLabel,
  EVENT_TYPES,
  followDefaultOptionLabel,
  reduce,
  replay,
  roleNameProblem,
  roleUsageText,
  type UiInput,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const named = (seq: number, name: string, source: "settings" | "config_file" = "settings") => frame(CHANNELS.assistantName, seq, EVENT_TYPES.assistantName, { name, source });

const identity = (overrides: Partial<AgentIdentityView> = {}): AgentIdentityView => ({
  roleId: "role-default",
  name: "二狗",
  defaultName: "二狗",
  nameSource: "default",
  voiceSource: "none",
  ...overrides,
});

/** 一份取回来的角色表：一个默认角色 + 给的那几个 agent */
const view = (overrides: Partial<AgentRolesView> = {}): AgentRolesView => ({
  defaultRoleId: "role-default",
  roles: [{ id: "role-default", name: "二狗", isDefault: true, usedBy: ["secretary"] }],
  agents: [{ agentId: "secretary", kind: "secretary", label: ASSISTANT_NAME_MARK, identity: identity() }],
  ...overrides,
});

/** 角色表取回来（接口回的那一份进状态层） */
const withRoles = (next: AgentRolesView): UiInput => ({ kind: "agent_roles", view: next });

describe("秘书指定的角色优先于全局的名字", () => {
  test("没取过、跟默认：全局的名字（没收到过名字事件是默认的\"二狗\"）", () => {
    expect(assistantNameOf(replay([]))).toBe("二狗");
    expect(assistantNameOf(replay([named(1, "阿福")]))).toBe("阿福");
    expect(agentIdentityOf(replay([]), "secretary")).toBeUndefined();
  });

  test("秘书指定了角色：界面各处用它；跟默认还是全局的名字——它可能比取回的那份新", () => {
    const own = replay([
      withRoles(
        view({
          roles: [{ id: "role-wenhan", name: "文翰", isDefault: false, usedBy: ["secretary"] }, { id: "role-default", name: "二狗", isDefault: true, usedBy: [] }],
          agents: [{ agentId: "secretary", kind: "secretary", label: ASSISTANT_NAME_MARK, identity: identity({ roleId: "role-wenhan", ownRoleId: "role-wenhan", name: "文翰", nameSource: "own" }) }],
        }),
      ),
    ]);
    expect(assistantNameOf(own)).toBe("文翰");
    // 全局的名字后来改了（名字频道上来的），秘书还是自己那个角色的名字
    expect(assistantNameOf(reduce(own, { kind: "frame", frame: named(1, "阿福") }))).toBe("文翰");

    const follows = replay([withRoles(view({ agents: [{ agentId: "secretary", kind: "secretary", label: ASSISTANT_NAME_MARK, identity: identity({ name: "阿福", defaultName: "阿福" }) }] }))]);
    expect(assistantNameOf(follows)).toBe("阿福");
    expect(assistantNameOf(reduce(follows, { kind: "frame", frame: named(1, "小美") }))).toBe("小美");
  });

  test("认这个 agent 现在的角色、名字和音色：别的 agent 的也在同一份里", () => {
    const state = replay([
      withRoles(
        view({
          roles: [
            { id: "role-default", name: "二狗", isDefault: true, usedBy: ["secretary"], voiceId: "v-1", voiceName: "音色甲" },
            { id: "role-wenhan", name: "文翰", isDefault: false, usedBy: ["pm-1"], voiceId: "v-2", voiceName: "音色乙" },
          ],
          agents: [
            { agentId: "secretary", kind: "secretary", label: ASSISTANT_NAME_MARK, identity: identity({ voiceId: "v-1", voiceName: "音色甲", voiceSource: "default" }) },
            { agentId: "pm-1", kind: "project", label: "项目「记账本」的维护者", identity: identity({ roleId: "role-wenhan", ownRoleId: "role-wenhan", name: "文翰", nameSource: "own", voiceId: "v-2", voiceName: "音色乙", voiceSource: "own" }) },
          ],
        }),
      ),
    ]);
    expect(agentIdentityOf(state, "pm-1")).toMatchObject({ roleId: "role-wenhan", name: "文翰", voiceId: "v-2", voiceSource: "own" });
    expect(agentIdentityOf(state, "tm-9")).toBeUndefined();
  });
});

describe("写成话", () => {
  test("名字、音色的来源；一行\"现在：名字 · 音色\"", () => {
    expect(agentNameNote(identity({ name: "文翰", nameSource: "own" }))).toBe("现在：文翰（指定的角色）");
    expect(agentNameNote(identity())).toBe("现在：二狗（跟默认角色）");
    expect(agentVoiceNote(identity({ voiceId: "v-1", voiceName: "示例音色", voiceSource: "default" }))).toBe("音色：示例音色（跟默认音色）");
    expect(agentVoiceNote(identity({ voiceId: "v-2", voiceName: "音色乙", voiceSource: "own" }))).toBe("音色：音色乙（角色指定的）");
    expect(agentVoiceNote(identity())).toBe("音色：还没有参考音色");
    expect(agentIdentityLine(identity({ name: "文翰", voiceName: "音色乙" }))).toBe("现在：文翰 · 音色：音色乙");
    expect(agentIdentityLine(identity())).toBe("现在：二狗 · 音色：语音插件没启用");
  });

  test("\"跟随默认\"那一项写默认角色的名字；音色那一项写默认音色的名字", () => {
    const list = view();
    expect(followDefaultOptionLabel(list)).toBe("跟随默认（二狗）");
    expect(followDefaultOptionLabel(undefined)).toBe("跟随默认");
    expect(defaultVoiceOptionLabel(view({ voices: [{ id: "v-1", name: "示例音色", referenceText: "示例", durationMs: 3000, sha256: "", importedAt: "" }], defaultVoiceId: "v-1" }))).toBe("跟默认音色（示例音色）");
    expect(defaultVoiceOptionLabel(view())).toBe("跟默认音色（还没有参考音色）");
  });

  test("谁在用：写出 agent 的叫法（秘书的名字占位换成现在的名字）；人多了只列前三个、写共几个；没人用也说明白", () => {
    const state = replay([
      named(1, "阿福"),
      withRoles(
        view({
          roles: [
            { id: "role-default", name: "阿福", isDefault: true, usedBy: ["secretary"] },
            { id: "role-wenhan", name: "文翰", isDefault: false, usedBy: ["pm-1", "tm-2"] },
            { id: "role-nobody", name: "小周", isDefault: false, usedBy: [] },
            { id: "role-many", name: "阿满", isDefault: false, usedBy: ["secretary", "pm-1", "tm-2", "pm-9", "tm-9"] },
          ],
          agents: [
            { agentId: "secretary", kind: "secretary", label: ASSISTANT_NAME_MARK, identity: identity({ name: "阿福", defaultName: "阿福" }) },
            { agentId: "pm-1", kind: "project", label: "项目「记账本」的维护者", identity: identity({ roleId: "role-wenhan", ownRoleId: "role-wenhan", name: "文翰", nameSource: "own" }) },
            { agentId: "tm-2", kind: "task", label: "长程任务 t-2「整理笔记」的维护者", identity: identity({ roleId: "role-wenhan", ownRoleId: "role-wenhan", name: "文翰", nameSource: "own" }) },
            { agentId: "pm-9", kind: "project", label: "项目「花店」的维护者", identity: identity({ roleId: "role-many", ownRoleId: "role-many", name: "阿满", nameSource: "own" }) },
            { agentId: "tm-9", kind: "task", label: "长程任务 t-9「做海报」的维护者", identity: identity({ roleId: "role-many", ownRoleId: "role-many", name: "阿满", nameSource: "own" }) },
          ],
        }),
      ),
    ]);
    const roles = state.agentRoles!.roles;
    expect(roleUsageText(state, roles[0]!)).toBe("谁在用：阿福");
    expect(roleUsageText(state, roles[1]!)).toBe("谁在用：项目「记账本」的维护者、长程任务 t-2「整理笔记」的维护者");
    expect(roleUsageText(state, roles[2]!)).toBe("还没有 agent 用");
    expect(roleUsageText(state, roles[3]!)).toBe("谁在用：阿福、项目「记账本」的维护者、长程任务 t-2「整理笔记」的维护者 等 5 个 agent");
    expect(agentLabelText(state, "secretary")).toBe("阿福");
    expect(agentLabelText(state, "nobody")).toBe("nobody");
  });
});

describe("改角色名字边打边查", () => {
  test("空着不算改；不合规的当场说；和现在的名字一样就不存", () => {
    expect(roleNameProblem("")).toBeUndefined();
    expect(roleNameProblem("   ")).toBeUndefined();
    expect(roleNameProblem("文翰")).toBeUndefined();
    expect(roleNameProblem("一二三四五六七八九")).toContain("最多 8 个字");
    expect(roleNameProblem("文\n翰")).toContain("换行");

    expect(canSaveRoleName("二狗", "文翰")).toBe(true);
    expect(canSaveRoleName("二狗", "  ")).toBe(false);
    expect(canSaveRoleName("二狗", "一二三四五六七八九")).toBe(false);
    expect(canSaveRoleName("文翰", " 文翰 ")).toBe(false);

    expect(canCreateRoleName("文翰")).toBe(true);
    expect(canCreateRoleName("  ")).toBe(false);
    expect(canCreateRoleName("一二三四五六七八九")).toBe(false);
  });
});
