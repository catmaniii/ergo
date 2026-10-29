// 工具包里"发附件"的开关（117 号票，state/send-attachment.ts）：默认开着（不写），关掉了写 false；拨一下之后别的几样原样；
// 工具包写成一句话、改动的说法里关掉了才提；维护者时间线里那条发附件的调用说成人话。
import { toolkitExpansions } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import {
  callSentence,
  type PlanToolkit,
  sendAttachmentHint,
  SEND_ATTACHMENT_LABEL,
  sendAttachmentOn,
  toolkitChangeText,
  toolkitText,
  withSendAttachment,
  withTellSecretary,
} from "../../src/state/index.ts";

const kit: PlanToolkit = { skills: ["notes-style"], mcp: [], bash: true, network: false };

describe("发附件的开关", () => {
  test("不写是开着（之前存下的工具包都没有这一项），关掉了是 false", () => {
    expect(sendAttachmentOn(kit)).toBe(true);
    expect(sendAttachmentOn({ ...kit, sendAttachment: true })).toBe(true);
    expect(sendAttachmentOn({ ...kit, sendAttachment: false })).toBe(false);
  });

  test("拨一下：关掉写 false，打开去掉这一项（和之前存下的一样）；别的几样原样，和给秘书发消息互不影响", () => {
    const off = withSendAttachment(kit, false);
    expect(off).toEqual({ ...kit, sendAttachment: false });
    expect(withSendAttachment(off, true)).toEqual(kit);
    expect(withSendAttachment(withTellSecretary(kit, false), false)).toEqual({ ...kit, tellSecretary: false, sendAttachment: false });
    // 原型的工具包（mcps）也能用
    const proto: { skills: string[]; mcps: string[]; bash: boolean; network: boolean; sendAttachment?: boolean } = { skills: [], mcps: ["demo"], bash: false, network: true };
    expect(withSendAttachment(proto, false)).toEqual({ ...proto, sendAttachment: false });
  });

  test("开关的名字和说明；工具包写成一句话时关掉了才提，改动的说法里写加上、去掉；打开算扩大（要用户批准）", () => {
    expect(SEND_ATTACHMENT_LABEL).toBe("发附件");
    expect(sendAttachmentHint()).toContain("作为附件发进它的会话");
    expect(sendAttachmentHint()).not.toContain("秘书");
    expect(toolkitText(kit)).toBe("bash 开、联网关；skill：notes-style；MCP：无");
    expect(toolkitText(withSendAttachment(kit, false))).toBe("bash 开、联网关、发附件关；skill：notes-style；MCP：无");
    expect(toolkitText(withSendAttachment(withTellSecretary(kit, false), false))).toBe("bash 开、联网关、给⟦个人助理⟧发消息关、发附件关；skill：notes-style；MCP：无");
    expect(toolkitChangeText(kit, withSendAttachment(kit, false))).toBe("去掉 发附件");
    expect(toolkitChangeText(withSendAttachment(kit, false), kit)).toBe("加上 发附件");
    expect(toolkitExpansions(withSendAttachment(kit, false), kit)).toEqual([{ kind: "send_attachment" }]);
    expect(toolkitExpansions(kit, withSendAttachment(kit, false))).toEqual([]);
  });
});

describe("维护者时间线里那条发附件的调用", () => {
  test("说成人话：给了名字的写名字，没给的写路径的文件名", () => {
    expect(callSentence({ tool: "send_attachment", argsSummary: "path=out/daily.html name=AI 日报.html" })).toMatchObject({ text: "把 AI 日报.html 作为附件发出" });
    expect(callSentence({ tool: "send_attachment", argsSummary: "path=charts/走势图.svg" }).text).toContain("走势图.svg");
  });
});
