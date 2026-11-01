// 367 号票：运行时交给 agent 的长通知在对话层画成一行（ChatItemView 的来信那一行），详情里全文照 Markdown 画：换行、列表都对。
// 用 React 在 Node 里渲染出来查；哪些折、总结从哪来在 test/state/agent-letters.test.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, test } from "vitest";
import { chatItems, type ConversationId, letterMarkdown, replay } from "../../src/state/index.ts";
import { ChatItemView } from "../../src/ui/conversation/ChatItemView.tsx";

const TM: ConversationId = "maintainer:tm-9";

/** 用户截图里那一段（2026-11-01）：运行时让负责人接着做第 3 阶段时交给它的阶段说明 */
const STAGE_NOTICE = [
  "用户让阶段 s3「第一波实现」接着做（之前停下是因为：用量超过预算）。看看用户在会话里说了什么，换个做法接着做；计数已经清零。",
  "现在是第 3/5 阶段 s3「第一波实现」：",
  "- 交付件：导入脚本 import.py；单元测试 tests/test_import.py",
  "- 验收标准：三家银行的账单都能导入（脚本：pytest tests/test_import.py）；重复的流水不入账（评审）",
  "- 模式：开放",
  "授权（只在当前阶段内有效）：",
  "- （没有）",
  "时序规则：",
  "- 先备份再改账目：写 ledger.db 之前先有当天的备份",
  "边界：",
  "- 工作目录 projects/ledger：文件工具只能写这里；工具包：bash 开，联网关",
  "- 一个阶段做完调用 complete_stage 宣布完成，由运行时验收（脚本、评审、用户），你自检不算验收",
  "做完调用 complete_stage 宣布阶段完成，由运行时验收。",
].join("\n");

/** 这条系统消息在对话层画出来的样子 */
function rendered(text: string, agentInput: boolean): string {
  const state = replay([
    {
      kind: "frame",
      frame: {
        channel: TM,
        seq: 1,
        type: "message",
        payload: { message: { id: "n1", conversation: TM, speaker: "system", time: "2026-10-06T21:40:00+08:00", parts: [{ type: "text", text }] }, ...(agentInput ? { agentInput: true } : {}) },
      },
    },
  ]);
  return renderToStaticMarkup(createElement(ChatItemView, { item: chatItems(state, TM)[0]!, actions: { onDetail: () => {} } }));
}

describe("对话层", () => {
  test("截图那一段画成一行：图标、是哪一步、时间、详情；不写种类，全文不出现在会话里", () => {
    const html = rendered(STAGE_NOTICE, true);
    expect(html).toContain("letter-line");
    expect(html).toContain('<span class="letter-sum">接着做第 3 阶段：第一波实现</span>');
    expect(html).toContain("详情 ›");
    expect(html).not.toContain("letter-kind");
    expect(html).not.toContain("系统说明");
    expect(html).not.toContain("交付件");
    expect(html).not.toContain("sys-note");
  });

  test("短的通知、没交给 agent 的说明照旧整段画", () => {
    const short = rendered("用户让任务继续了。接着做。", true);
    expect(short).toContain("sys-note");
    expect(short).toContain("用户让任务继续了。接着做。");
    expect(short).not.toContain("letter-line");
    const note = rendered(STAGE_NOTICE, false);
    expect(note).toContain("交付件");
    expect(note).not.toContain("letter-line");
  });
});

describe("详情里的全文", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, letterMarkdown(STAGE_NOTICE)));

  test("小标题各成一段，不并进上一个列表项；列表还是列表", () => {
    for (const heading of ["授权（只在当前阶段内有效）：", "时序规则：", "边界："]) expect(html).toContain(`<p>${heading}`);
    expect(html.match(/<ul>/g)).toHaveLength(4);
    expect(html.match(/<li>/g)).toHaveLength(7);
    expect(html).toContain("<li>验收标准：三家银行的账单都能导入");
  });

  test("运行时用单个换行分的行还是一行一行的，最后一句也在", () => {
    expect(html).toMatch(/计数已经清零。<br\/>\s*现在是第 3\/5 阶段/);
    expect(html).toContain("<p>做完调用 complete_stage 宣布阶段完成");
  });
});
