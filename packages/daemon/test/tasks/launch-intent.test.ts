// 只有用户点明了才发起任务（规格第 7 节，ADR 0019，58 号票）：运行时判定用户这一轮点明了哪种任务（表格测试）。
import { describe, expect, it } from "vitest";
import type { UserTurn } from "../../src/quick-actions/index.ts";
import { launchIntent, launchRefusal } from "../../src/tasks/launch-intent.ts";

const typed = (...texts: string[]): UserTurn => ({ typed: texts, spoken: [], quotes: [], cards: [] });
const kindOf = (turn: UserTurn) => launchIntent(turn)?.kind;
const TOOLS = { workflow: "start_workflow", long_running: "create_task", suggest: "suggest_task" };

describe("用户点明了哪种任务", () => {
  it.each([
    ["/流程 把下载目录按类型整理好", "workflow"],
    ["  /任务 调研家用 NAS", "long_running"],
    // 310 号票：命令一律英文（中文的老写法照样认）
    ["/workflow 把下载目录按类型整理好", "workflow"],
    ["/task 调研家用 NAS", "long_running"],
    ["/task", "long_running"],
    // 175 号票：英文别名
    ["/ergo_workflow sort the downloads folder", "workflow"],
    ["/ergo_task research home NAS", "long_running"],
    ["/ergo_task", "long_running"],
    ["按流程做：把下载目录按类型整理好", "workflow"],
    ["帮我发起一个流程，整理下载目录", "workflow"],
    ["这件事作为流程来做吧", "workflow"],
    ["发起任务：调研家用 NAS", "long_running"],
    ["开个长程任务调研家用 NAS", "long_running"],
    ["建个任务，每周汇总账单", "long_running"],
    // 两种都说了：按流程（说得更具体）
    ["发起任务，按流程做", "workflow"],
    ["按照这个流程做：先备份再清理", "workflow"],
    ["照那条流程办一下", "workflow"],
    ["这次用流程做，别拖", "workflow"],
    // 客气的请求：问句的样子，其实是要你做
    ["能帮我按流程做吗？", "workflow"],
    ["能不能帮我发起一个任务？调研家用 NAS", "long_running"],
    ["麻烦作为长程任务来做吧？", "long_running"],
    // "不管""不如"这类不是否定
    ["不管怎样都按流程做", "workflow"],
    ["不如发起任务慢慢弄", "long_running"],
    // 白名单（最后一轮核对）：句首就是祈使的发起说法，前面只有称呼、客气词
    ["用流程帮我整理下载目录", "workflow"],
    ["二狗，发起一个长程任务：调研家用 NAS", "long_running"],
    ["请按流程做：把照片备份到移动硬盘", "workflow"],
    ["麻烦你建个长程任务跟进报税", "long_running"],
    ["你帮我发起一个流程：清理桌面", "workflow"],
    ["下载目录太乱了。帮我按流程做：按类型整理好", "workflow"],
    ["按流程做，别漏步骤", "workflow"],
  ] as const)("%s → %s", (text, kind) => {
    expect(kindOf(typed(text))).toBe(kind);
  });

  it.each([
    "帮我整理一份 X 的调研",
    // 310 号票：英文写法后面紧跟 - _ : 的是 skill 的名字
    "/task-runner 跑一下",
    "/tasks",
    "/workflow:x",
    "这个流程好麻烦",
    // 否定：不、没、别、不要、不用、算了、暂时不……
    "不用发起任务，你直接回答就行",
    "别按流程做",
    "我不想发起任务",
    "暂时不按流程做",
    "按流程做就算了",
    "先不发起任务，聊聊再说",
    "没必要发起任务",
    "不要按照这个流程做",
    "发起任务？不用了",
    "开个长程任务的事不了了之吧",
    // 商量的问句、只是问能不能
    "要不要发起任务？",
    "是不是该按流程做？",
    "能发起任务吗",
    // 叙述：单写"流程""长程任务"，或者没有发起的说法
    "公司报销要走流程",
    "上周那个长程任务做完了",
    "我上周发起了一个任务",
    "流程图怎么画",
    "打开任务看板看看",
    "/流程图怎么画",
    "/tasks",
    "/workflows are cool",
    // 复审：说法后面跟着否定、贬低，或者是在叙述过去的事——宁可漏判
    "按流程做没必要",
    "发起任务不如直接问我",
    "我昨天发起任务的时候报错了",
    // 同类的十几句
    "按流程做太麻烦了",
    "上次按流程做出了问题",
    "之前发起任务的那个报告呢",
    "按流程做的话要多久",
    "何必按流程做",
    "作为流程来做反而更慢",
    "刚才发起任务失败了",
    "发起任务是要花钱的",
    "我同事说要按流程做",
    "按流程做多余",
    "用流程做没意思",
    "建个任务有什么用",
    "按流程做了，结果一样",
    // 最后一轮核对试的 8 句误判和 2 句问功能本身（按核对说的类别各写一句）
    "按流程做，其实没必要", // 下一分句才否定
    "发起任务，太麻烦了", // 下一分句才贬低
    "上礼拜按流程做过一次", // 词表外的时间词
    "我老婆问要不要按流程做", // 转述别人的提问
    "难道还要按流程做", // 不带问号的反问
    "要是按流程做会慢很多", // 条件句
    "如果发起任务就要等很久", // 条件句
    "文档上写着：按流程做", // 引用文档原话
    "发起任务还是直接问你好", // 语音转写里没有标点的"还是"
    "按流程做是怎么回事", // 问功能本身
    "发起一个流程要多久", // 问功能本身
    // 自己再想的 10 句
    "上个礼拜发起任务的时候卡住了",
    "老板说按流程做",
    "假如按流程做要几步",
    "难道不能发起任务",
    "据说用流程做更稳",
    "这个功能叫发起任务",
    "说明里写：建个长程任务就行",
    "发起任务或者直接回答都行",
    "按流程做。算了，还是你直接做吧",
    "流程和长程任务有什么区别",
  ])("没点明：%s", (text) => {
    expect(kindOf(typed(text))).toBeUndefined();
  });

  it("只有命令本身：/流程、/任务 后面直接回车也算", () => {
    expect(kindOf(typed("/流程"))).toBe("workflow");
    expect(kindOf(typed("/任务\n调研 NAS"))).toBe("long_running");
  });

  it("语音转写和打的字一样算；引用块和引用的卡片里的话不算", () => {
    expect(launchIntent({ typed: [], spoken: ["按流程做，把照片备份到移动硬盘"], quotes: [], cards: [] })).toEqual({ kind: "workflow", source: "voice" });
    // 语音转写常常没有标点：拿不定的"还是"照样不算
    expect(launchIntent({ typed: [], spoken: ["发起任务还是直接问你好"], quotes: [], cards: [] })).toBeUndefined();
    expect(launchIntent({ typed: ["看看这个"], spoken: [], quotes: ["发起任务：调研家用 NAS"], cards: [["按流程做"]] })).toBeUndefined();
  });
});

describe("秘书要发起的种类对不上时交回的原因", () => {
  it("点明的种类和要建的一样：可以建", () => {
    expect(launchRefusal(typed("发起任务：调研 NAS"), "long_running", TOOLS)).toBeUndefined();
    expect(launchRefusal(typed("/流程 整理下载目录"), "workflow", TOOLS)).toBeUndefined();
  });

  it("点明的是另一种：说清用哪个工具；没点明：按普通对话处理，最多给建议卡", () => {
    expect(launchRefusal(typed("发起任务：调研 NAS"), "workflow", TOOLS)).toMatch(/点明的是长程任务.*create_task/);
    expect(launchRefusal(typed("按流程做：整理下载目录"), "long_running", TOOLS)).toMatch(/点明的是流程.*start_workflow/);
    const refused = launchRefusal(typed("帮我整理一份 X 的调研"), "long_running", TOOLS);
    expect(refused).toContain("没有点明要发起任务");
    expect(refused).toContain("suggest_task");
    expect(refused).toContain("“作为流程”或“作为长程任务”");
  });
});
