// 工具包里"给秘书发消息"的开关（102 号票，state/tell-secretary.ts）：默认开着（不写），关掉了写 false；拨一下之后别的几样原样；
// 工具包写成一句话、改动的说法里关掉了才提；维护者时间线里那条工具调用说成人话。
import { describe, expect, test } from "vitest";
import {
  callSentence,
  type PlanToolkit,
  tellSecretaryHint,
  TELL_SECRETARY_LABEL,
  tellSecretaryOn,
  toolkitChangeText,
  toolkitText,
  withTellSecretary,
} from "../../src/state/index.ts";

const kit: PlanToolkit = { skills: ["notes-style"], mcp: [], bash: true, network: false };

describe("给秘书发消息的开关", () => {
  test("不写是开着（之前存下的工具包都没有这一项），关掉了是 false", () => {
    expect(tellSecretaryOn(kit)).toBe(true);
    expect(tellSecretaryOn({ ...kit, tellSecretary: true })).toBe(true);
    expect(tellSecretaryOn({ ...kit, tellSecretary: false })).toBe(false);
  });

  test("拨一下：关掉写 false，打开去掉这一项（和之前存下的一样）；别的几样原样", () => {
    const off = withTellSecretary(kit, false);
    expect(off).toEqual({ ...kit, tellSecretary: false });
    expect(withTellSecretary(off, true)).toEqual(kit);
    expect(withTellSecretary({ ...kit, tellSecretary: true }, true)).toEqual(kit);
    // 原型的工具包（mcps）也能用
    const proto: { skills: string[]; mcps: string[]; bash: boolean; network: boolean; tellSecretary?: boolean } = { skills: [], mcps: ["demo"], bash: false, network: true };
    expect(withTellSecretary(proto, false)).toEqual({ ...proto, tellSecretary: false });
  });

  test("开关的名字和说明；工具包写成一句话时关掉了才提，改动的说法里写加上、去掉", () => {
    // 提到秘书的写名字占位（43 号票），界面上显示用户起的名字
    expect(TELL_SECRETARY_LABEL).toBe("给⟦个人助理⟧发消息");
    expect(tellSecretaryHint()).toContain("由⟦个人助理⟧在对话里转告你");
    expect(tellSecretaryHint()).not.toContain("秘书");
    expect(toolkitText(kit)).toBe("bash 开、联网关；skill：notes-style；MCP：无");
    expect(toolkitText(withTellSecretary(kit, false))).toBe("bash 开、联网关、给⟦个人助理⟧发消息关；skill：notes-style；MCP：无");
    expect(toolkitChangeText(kit, withTellSecretary(kit, false))).toBe("去掉 给⟦个人助理⟧发消息");
    expect(toolkitChangeText(withTellSecretary(kit, false), kit)).toBe("加上 给⟦个人助理⟧发消息");
  });
});

describe("维护者时间线里那条工具调用", () => {
  test("说成人话：给秘书发消息加原话的前几个字；没写原话的退回中文名", () => {
    expect(callSentence({ tool: "tell_secretary", argsSummary: "text=发票里有 3 张抬头写错了，我先挪到 wrong/ 目录里了。" })).toEqual({ text: "给⟦个人助理⟧发消息：发票里有 3 张抬头写错了，我先挪到 wrong/ 目录里…", said: true });
    expect(callSentence({ tool: "tell_secretary", argsSummary: "" })).toEqual({ text: "给⟦个人助理⟧发消息", said: false });
  });
});
