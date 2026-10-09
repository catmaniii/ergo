// 个人助理的名字（43 号票）：起名的规则，和守护进程生成的话里的名字占位怎么换成名字。
import { describe, expect, it } from "vitest";
import { ASSISTANT_NAME_MARK, checkAssistantName, currentWording, DEFAULT_ASSISTANT_NAME, fillAssistantName, splitAssistantName } from "../src/index.ts";

describe("起名的规则：去掉首尾空白后 1–8 个字，不能有换行", () => {
  it.each<[string, string]>([
    ["二狗", "二狗"],
    ["  二狗 ", "二狗"],
    ["狗", "狗"],
    ["小助手管家八个字", "小助手管家八个字"],
    ["\t阿福　", "阿福"],
    ["Jarvis", "Jarvis"],
    ["小 狗", "小 狗"],
    // emoji 算一个字
    ["🐶二狗", "🐶二狗"],
  ])("「%s」可以，存成「%s」", (raw, name) => {
    expect(checkAssistantName(raw)).toEqual({ ok: true, name });
  });

  it.each<[string, string, RegExp]>([
    ["空的", "", /不能是空的/],
    ["全是空白", "   　", /不能是空的/],
    ["九个字", "一二三四五六七八九", /最多 8 个字/],
    ["中间有换行", "二\n狗", /不能有换行/],
    ["中间有回车", "二\r狗", /不能有换行/],
    ["行分隔符", "二\u2028狗", /不能有换行/],
    ["控制字符", "二\u0007狗", /不能有控制字符/],
    ["带着名字占位", `${ASSISTANT_NAME_MARK}`, /不能含/],
  ])("%s：不合规，说明原因", (_case, raw, reason) => {
    const result = checkAssistantName(raw);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(reason);
  });

  it("默认是\"个人助理\"，它自己当然合规", () => {
    expect(DEFAULT_ASSISTANT_NAME).toBe("个人助理");
    expect(checkAssistantName(DEFAULT_ASSISTANT_NAME)).toEqual({ ok: true, name: "个人助理" });
  });
});

describe("名字占位：守护进程生成的话里提到秘书的地方不写死名字，前端按当前名字显示", () => {
  it("拆成文字和名字两种段，按先后", () => {
    expect(splitAssistantName(`上一条消息处理时中断了，${ASSISTANT_NAME_MARK}没有接着处理`)).toEqual([
      { text: "上一条消息处理时中断了，" },
      { name: true },
      { text: "没有接着处理" },
    ]);
    expect(splitAssistantName(`${ASSISTANT_NAME_MARK}对话`)).toEqual([{ name: true }, { text: "对话" }]);
    expect(splitAssistantName(`${ASSISTANT_NAME_MARK}和${ASSISTANT_NAME_MARK}`)).toEqual([{ name: true }, { text: "和" }, { name: true }]);
  });

  it("没有占位的话原样一段；空字符串没有段", () => {
    expect(splitAssistantName("提醒：交房租")).toEqual([{ text: "提醒：交房租" }]);
    expect(splitAssistantName("")).toEqual([]);
  });

  it("纯文字的地方（浏览器通知、title）直接换成名字", () => {
    expect(fillAssistantName(`${ASSISTANT_NAME_MARK}对话`, "二狗")).toBe("二狗对话");
    expect(fillAssistantName(`${ASSISTANT_NAME_MARK}按你的话取消了；${ASSISTANT_NAME_MARK}不能联网`, "阿福")).toBe("阿福按你的话取消了；阿福不能联网");
    expect(fillAssistantName("没有占位", "二狗")).toBe("没有占位");
  });
});

describe("43 号票之前存下的旧说法：前端显示时按对照表换成名字占位（只认这几句固定的话）", () => {
  const M = ASSISTANT_NAME_MARK;
  it.each<[string, string, string]>([
    ["审批卡、交给我做、中断、快速动作事项的来源（整个字段）", "秘书对话", `${M}对话`],
    ["审批卡的纯文本降级", "审批（秘书对话）：读文件「~/note.txt」 · 越出项目目录", `审批（${M}对话）：读文件「~/note.txt」 · 越出项目目录`],
    ["交给我做事项的说明", '秘书对话里要做的这件事守卫判定为"交给我做"，请你亲手完成', `${M}对话里要做的这件事守卫判定为"交给我做"，请你亲手完成`],
    ["中断事项的说明", "秘书对话里正在执行通用 bash 时，守护进程（或 agent 子进程）重启了", `${M}对话里正在执行通用 bash 时，守护进程（或 agent 子进程）重启了`],
    ["秘书没能回复的系统说明", "秘书这次没能回复：模型调用超过 0.6 秒没有结束，已中止", `${M}这次没能回复：模型调用超过 0.6 秒没有结束，已中止`],
    ["读附件出错的系统说明", "秘书这次没能回复：读取附件出错（文件不见了）", `${M}这次没能回复：读取附件出错（文件不见了）`],
    ["被打断的系统说明（带引用）", "上一条消息「第一条」处理时中断了，秘书没有接着处理；需要的话请重发。", `上一条消息「第一条」处理时中断了，${M}没有接着处理；需要的话请重发。`],
    ["被打断的系统说明（没有引用）", "上一条消息处理时中断了，秘书没有接着处理；需要的话请重发。", `上一条消息处理时中断了，${M}没有接着处理；需要的话请重发。`],
    ["提醒卡的处理结果", "秘书按你的话取消了", `${M}按你的话取消了`],
    ["提醒卡的处理结果（带动作名）", "已取消：秘书按你的话取消了", `已取消：${M}按你的话取消了`],
    ["节假日数据缺失事项的说明", "去官方来源取 2027 年的数据（秘书不能联网）。", `去官方来源取 2027 年的数据（${M}不能联网）。`],
    ["阶段等你验收的说明（待我处理改叫待办）", "阶段 s2「验收」等你验收：已放进待我处理。", "阶段 s2「验收」等你验收：已放进待办。"],
    ["催写回到次数的说明（待我处理改叫待办）", '这一段（pm-1-s3）没写回就结束了，转给你拍板（待我处理里的"卡住求助"）。', '这一段（pm-1-s3）没写回就结束了，转给你拍板（待办里的"卡住求助"）。'],
  ])("%s", (_case, old, now) => {
    expect(currentWording(old)).toBe(now);
  });

  it.each<[string, string]>([
    ["agent 回复里的原话", "我是你的秘书，有事尽管说"],
    ["用户说的话里正好有“秘书对话”（不是整个字段）", "我想看看秘书对话的记录"],
    ["引用里的话不带冒号，不是那句说明", "上一条消息「秘书这次没能回复是什么意思」处理时中断了，"],
    ["新的话（已经是占位）原样", `${M}这次没能回复：出错`],
    ["别的话", "提醒：交房租"],
  ])("不在对照表里的不动：%s", (_case, text) => {
    expect(currentWording(text)).toBe(text);
  });
});
