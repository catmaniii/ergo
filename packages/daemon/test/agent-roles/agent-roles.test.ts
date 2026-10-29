// 业务层：角色（248 号票）——配置区 agent-roles.json 怎么存、怎么查、怎么回退、迁移怎么做。
// 光看这一层，不起守护进程：
// - 默认角色的名字和音色就是全局名字（43）和全局选中的参考音色（31）：读按全局现取，写也写全局；
// - 角色：名字照 43 号票的规矩查，音色要参考音色清单里现在有的（写不存在的拒收；插件没启用时写音色拒收，名字和角色分配照常）；
// - 没指定角色 = 跟默认；指定默认角色也等于跟默认（文件里不留这一项）；
// - 删角色：默认角色不能删，还有 agent 指定的不能删（写明谁在用）；
// - 迁移：第一次读到文件不存在时，从旧的 agent-profiles.json + 全局名字 + 全局选中音色造默认角色和各个 agent 的角色；
//   和默认角色完全一样的 agent 不单独建角色（它现在就是那两样），旧文件保留不删；第二次启动不再迁移；
//   迁移写不进去时先在内存里用迁移结果（名字和音色不丢），下次启动再写；
// - 改了叫 onChange（带这次该重新装配的 agent id）。
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENT_ROLE_ID } from "@ergo/protocol";
import { describe, expect, it, vi } from "vitest";
import { openAgentRoles, type RoleVoices } from "../../src/agent-roles/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 一份参考音色清单（语音插件在运行时的样子）；删掉之后 get 回 undefined */
function fakeVoices(ids: readonly string[], currentId?: string): RoleVoices & { drop(id: string): void } {
  const voices = new Set(ids);
  return {
    list: () => ({
      voices: [...voices].map((id) => ({ id, name: `音色 ${id}`, referenceText: "示例", durationMs: 3000, sha256: "", importedAt: "" })),
      ...(currentId === undefined ? {} : { currentId }),
    }),
    get: (voiceId) => (voices.has(voiceId) ? { id: voiceId, name: `音色 ${voiceId}` } : undefined),
    drop: (voiceId) => voices.delete(voiceId),
  };
}

function setup(options: { voices?: (RoleVoices & { drop(id: string): void }) | undefined; legacy?: unknown; name?: string } = {}) {
  const dir = makeTempDir();
  const file = path.join(dir, "config", "agent-roles.json");
  const legacyFile = path.join(dir, "config", "agent-profiles.json");
  const logs: string[] = [];
  const voiceSource = "voices" in options ? options.voices : fakeVoices(["v-1", "v-2"], "v-1");
  let name = options.name ?? "二狗";
  const selected: string[] = [];
  if (options.legacy !== undefined) {
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify(options.legacy));
  }
  const roles = openAgentRoles({
    file,
    legacyFile,
    assistantName: () => name,
    setAssistantName: (next) => {
      name = next;
    },
    ...(voiceSource === undefined ? {} : { voices: () => voiceSource, selectVoice: (voiceId: string) => selected.push(voiceId) }),
    log: (line) => logs.push(line),
  });
  const read = (): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    roles,
    file,
    legacyFile,
    logs,
    read,
    voices: voiceSource,
    selected,
    name: () => name,
    setName: (next: string) => {
      name = next;
    },
  };
}

/** 旧配置（241 号票）的形状 */
const legacyFile = (agents: Record<string, { name?: string; voiceId?: string }>) => ({ format: 1, agents });
const legacyEntries = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

describe("角色：没有文件时就是只有默认角色", () => {
  it("没迁移过、没写过：defaultRole 是全局名字 + 全局音色，所有 agent 跟默认，文件还没建出来", () => {
    const { roles, file } = setup();
    expect(roles.defaultRoleId()).toBe(DEFAULT_AGENT_ROLE_ID);
    expect(roles.defaultRole()).toMatchObject({ id: DEFAULT_AGENT_ROLE_ID, name: "二狗", isDefault: true });
    expect(roles.roleOf("secretary")).toMatchObject({ name: "二狗", isDefault: true });
    expect(roles.ownRoleIdOf("secretary")).toBeUndefined();
    expect(roles.voiceIdOf("secretary")).toBeUndefined();
    expect(roles.assignedNameOf("secretary")).toBeUndefined();
    // 只是读：不写到磁盘上
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("迁移：从旧的名字音色配置 + 全局名字 + 全局音色造一张角色表", () => {
  it("默认角色用全局的名字和音色；和默认角色不一样的 agent 各造一个角色（同一个名字+音色共用一个），旧文件保留", () => {
    const { roles, file, legacyFile: legacy, logs, read } = setup({
      legacy: legacyFile({
        secretary: { name: "小明" },
        "pm-1": { voiceId: "v-2" },
        "pm-2": { name: "二狗", voiceId: "v-1" },
        "tm-1": { name: "老王", voiceId: "v-2" },
        "tm-2": { name: "老王", voiceId: "v-2" },
      }),
    });
    roles.start();
    const stored = read() as { defaultRoleId: string; roles: { id: string; name: string; voiceId?: string }[]; assignments: Record<string, string> };
    expect(stored.defaultRoleId).toBe(DEFAULT_AGENT_ROLE_ID);
    // 默认角色：全局名字 + 全局选中的音色
    expect(stored.roles[0]).toEqual({ id: DEFAULT_AGENT_ROLE_ID, name: "二狗", voiceId: "v-1" });
    // pm-2 和默认角色完全一样：不单独建角色（它现在就是那两样，不丢）
    expect(stored.assignments["pm-2"]).toBeUndefined();
    // 两个维护者名字音色一样：共用一个角色
    expect(stored.assignments["tm-1"]).toBe(stored.assignments["tm-2"]);
    expect(stored.roles.filter((role) => role.name === "老王")).toHaveLength(1);

    // 迁完读出来的样子：名字一个不丢，没配音色的那一项还是跟默认
    expect(roles.roleOf("secretary")).toMatchObject({ name: "小明" });
    expect(roles.voiceIdOf("secretary")).toBeUndefined();
    expect(roles.roleOf("pm-1")).toMatchObject({ name: "二狗" });
    expect(roles.voiceIdOf("pm-1")).toBe("v-2");
    expect(roles.roleOf("tm-1")).toMatchObject({ name: "老王" });
    expect(roles.voiceIdOf("tm-1")).toBe("v-2");
    expect(roles.roleOf("pm-2").isDefault).toBe(true);

    // 日志一行（给开发者看的，带数量）；旧文件原样留着
    expect(logs.join("\n")).toContain("已把 4 个 agent 的名字音色迁进角色表");
    expect(legacyEntries(legacy)).toEqual(legacyFile({ secretary: { name: "小明" }, "pm-1": { voiceId: "v-2" }, "pm-2": { name: "二狗", voiceId: "v-1" }, "tm-1": { name: "老王", voiceId: "v-2" }, "tm-2": { name: "老王", voiceId: "v-2" } }));
    // 迁完文件在
    expect(fs.existsSync(file)).toBe(true);
  });

  it("再启动一次不重复迁移；旧配置后来改了也不再管", () => {
    const { roles, read } = setup({ legacy: legacyFile({ secretary: { name: "小明" } }) });
    roles.start();
    const first = read();
    roles.start();
    expect(read()).toEqual(first);
    expect(roles.roleOf("secretary")).toMatchObject({ name: "小明" });
  });

  it("没有旧配置：只造默认角色，一个 agent 都不分配（谁都没丢东西）", () => {
    const { roles, read } = setup();
    roles.start();
    expect(read()).toEqual({ format: 1, defaultRoleId: DEFAULT_AGENT_ROLE_ID, roles: [{ id: DEFAULT_AGENT_ROLE_ID, name: "二狗", voiceId: "v-1" }], assignments: {} });
  });

  it("旧配置读不了（不是 JSON）：迁移照做（默认角色），旧文件不动，记日志", () => {
    const { roles, legacyFile: legacy, logs, read } = setup();
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "{ 这不是 JSON");
    roles.start();
    expect((read() as { assignments: Record<string, string> }).assignments).toEqual({});
    expect(fs.readFileSync(legacy, "utf8")).toBe("{ 这不是 JSON");
    expect(logs.join("\n")).toContain("旧的名字音色配置不是 JSON");
  });

  it("迁移写不进去：先在内存里用迁移结果（名字和音色不丢），下次启动再写", () => {
    const { roles, file, legacyFile: legacy } = setup({ legacy: legacyFile({ secretary: { name: "小明" } }) });
    // 让原子写最后那一下改名失败（265 号票起临时文件名带随机串，占不住了）；用不算"被占着"的错误，不等重试：写会失败
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("磁盘满了"), { code: "ENOSPC" });
    });
    roles.start();
    expect(fs.existsSync(file)).toBe(false);
    // 文件没写成，但这次运行里名字和音色是迁过来的
    expect(roles.roleOf("secretary")).toMatchObject({ name: "小明" });
    expect(roles.voiceIdOf("secretary")).toBeUndefined();
    expect(roles.roleOf("pm-1").isDefault).toBe(true);
    expect(fs.readFileSync(legacy, "utf8")).toContain("小明");
    // 改名恢复正常：下一次启动能写进去
    rename.mockRestore();
    roles.start();
    expect((JSON.parse(fs.readFileSync(file, "utf8")) as { assignments: Record<string, string> })["assignments"]["secretary"]).toBeDefined();
  });
});

describe("默认角色：名字和音色就是全局那两个", () => {
  it("全局名字改了默认角色跟着变；refreshGlobals 把文件里那份镜像也记上", () => {
    const { roles, read, setName } = setup();
    roles.start();
    expect(roles.defaultRole().name).toBe("二狗");
    // 设置顶上那个名字输入框改名（43）：默认角色的名字跟着（全局是真相）
    setName("阿福");
    expect(roles.defaultRole().name).toBe("阿福");
    expect(roles.roleOf("secretary").name).toBe("阿福");
    roles.refreshGlobals();
    expect((read() as { roles: { name: string }[] }).roles[0]!.name).toBe("阿福");
  });

  it("改默认角色的名字等于改全局名字；改它的音色等于在语音页里选一个", () => {
    const { roles, selected, name, read } = setup();
    roles.start();
    roles.update(DEFAULT_AGENT_ROLE_ID, { name: "阿福", voiceId: "v-2" });
    expect(name()).toBe("阿福");
    expect(selected).toEqual(["v-2"]);
    expect(roles.defaultRole()).toMatchObject({ name: "阿福" });
    expect((read() as { roles: { name: string }[] }).roles[0]!.name).toBe("阿福");
  });

  it("把别的角色设成默认：全局名字和音色跟着变成那个角色的，旧的默认角色留下自己原来的名字", () => {
    const { roles, selected, name, read } = setup();
    roles.start();
    const created = roles.create({ name: "小明", voiceId: "v-2" });
    const xiaoming = created.roles.find((role) => role.name === "小明")!;
    roles.setDefault(xiaoming.id);
    expect(roles.defaultRoleId()).toBe(xiaoming.id);
    expect(name()).toBe("小明");
    expect(selected).toEqual(["v-2"]);
    const stored = read() as { roles: { id: string; name: string }[]; defaultRoleId: string };
    expect(stored.defaultRoleId).toBe(xiaoming.id);
    // 旧的默认角色留下自己原来的名字
    expect(stored.roles.find((role) => role.id === DEFAULT_AGENT_ROLE_ID)!.name).toBe("二狗");
    // 不指定角色的 agent 现在叫小明
    expect(roles.roleOf("secretary")).toMatchObject({ name: "小明", isDefault: true });
  });
});

describe("角色的增删改：校验、默认唯一、删在用", () => {
  it("新建：名字不合规、音色不存在、插件没启用时写音色都拒收，什么都没改", () => {
    const { roles, file } = setup();
    roles.start();
    const before = fs.readFileSync(file, "utf8");
    expect(() => roles.create({ name: "" })).toThrow(/名字/);
    expect(() => roles.create({ name: "一二三四五六七八九" })).toThrow(/最多 8 个字/);
    expect(() => roles.create({ name: "小周", voiceId: "v-9" })).toThrow(/没有这个参考音色/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);

    // 语音插件没启用：写音色拒收，名字照常
    const off = setup({ voices: undefined });
    off.roles.start();
    expect(() => off.roles.create({ name: "小周", voiceId: "v-1" })).toThrow(/语音插件没启用/);
    expect(off.roles.create({ name: "小周" }).roles.some((role) => role.name === "小周")).toBe(true);
  });

  it("改名 / 换音色只改点名的那个角色；音色清空 = 跟当前默认音色", () => {
    const { roles } = setup();
    roles.start();
    const created = roles.create({ name: "小明", voiceId: "v-2" });
    const id = created.roles.find((role) => role.name === "小明")!.id;
    roles.update(id, { name: "小明" });
    expect(roles.roleOf("nobody")).toMatchObject({ isDefault: true });
    const after = roles.create({ name: "另一个" }).roles.find((role) => role.id === id)!;
    expect(after.name).toBe("小明");
    roles.update(id, { voiceId: null });
    expect(roles.document().roles.find((role) => role.id === id)!.voiceId).toBeUndefined();
  });

  it("删角色：默认角色不能删；还有 agent 指定的不能删（说清是谁）；没人用的删掉", () => {
    const { roles } = setup();
    roles.start();
    expect(() => roles.remove(DEFAULT_AGENT_ROLE_ID)).toThrow(/默认角色不能删/);
    const created = roles.create({ name: "小明" });
    const id = created.roles.find((role) => role.name === "小明")!.id;
    roles.assign("pm-1", id);
    expect(() => roles.remove(id)).toThrow(/pm-1/);
    roles.assign("pm-1", null);
    expect(() => roles.remove(id)).not.toThrow();
    expect(roles.document().roles.some((role) => role.id === id)).toBe(false);
    expect(() => roles.remove("role-nope")).toThrow(/没有这个角色/);
  });

  it("指定角色：null 和指定默认角色都算跟默认（文件里不留这一项）；不存在的角色拒收", () => {
    const { roles, read } = setup();
    roles.start();
    const created = roles.create({ name: "小明" });
    const id = created.roles.find((role) => role.name === "小明")!.id;
    roles.assign("pm-1", id);
    expect(roles.ownRoleIdOf("pm-1")).toBe(id);
    expect(roles.assignedNameOf("pm-1")).toBe("小明");
    roles.assign("pm-1", DEFAULT_AGENT_ROLE_ID);
    expect(roles.ownRoleIdOf("pm-1")).toBeUndefined();
    expect((read() as { assignments: Record<string, string> }).assignments).toEqual({});
    expect(() => roles.assign("pm-1", "role-nope")).toThrow(/没有这个角色/);
  });

  it("文件写坏了：读的时候按只有默认角色算（记日志），不改的时候不覆盖它", () => {
    const { roles, file, logs } = setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ 这不是 JSON");
    expect(roles.roleOf("secretary").isDefault).toBe(true);
    expect(logs.join("\n")).toContain("形状不对");
    expect(fs.readFileSync(file, "utf8")).toBe("{ 这不是 JSON");
    expect(() => roles.create({ name: "小明" })).toThrow(/读不了/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ 这不是 JSON");
  });

  it("改了叫 onChange（带这次要重新装配的 agent id）；取消登记之后不再叫", () => {
    const { roles } = setup();
    roles.start();
    const seen: (readonly string[])[] = [];
    const off = roles.onChange((ids) => seen.push(ids));
    const created = roles.create({ name: "小明" });
    const id = created.roles.find((role) => role.name === "小明")!.id;
    roles.assign("pm-1", id);
    roles.update(id, { name: "小明" });
    expect(seen).toEqual([["pm-1"], ["pm-1"]]);
    off();
    roles.assign("pm-2", id);
    expect(seen).toEqual([["pm-1"], ["pm-1"]]);
  });
});

describe("音色：角色指定的那个被删了、语音插件停了", () => {
  it("参考音色后来被删了：voiceIdOf 还回那个 id（合成那边回退当前默认），角色不动", () => {
    const { roles, voices } = setup();
    roles.start();
    const created = roles.create({ name: "小明", voiceId: "v-2" });
    const id = created.roles.find((role) => role.name === "小明")!.id;
    roles.assign("tm-2", id);
    voices!.drop("v-2");
    expect(roles.voiceIdOf("tm-2")).toBe("v-2");
    expect(roles.roleOf("tm-2")).toMatchObject({ name: "小明" });
  });
});
