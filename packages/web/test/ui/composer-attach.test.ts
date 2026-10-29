// 输入框左边的"＋"（附件菜单，ui/conversation/Composer.tsx；143 号票）：秘书、任务和项目的维护者会话用的是同一个输入框，
// "＋"三处都有，菜单一样（图片、文件、作为材料投喂）；只读的会话（任务已结束、归档的项目）没有输入框，"＋"也就没有，
// 换成一行说明（会话组件底部那一格 ComposerSlot）。用 React 在 Node 里渲染出来查（挂一个不连线的 StoreProvider：
// 渲染时不跑副作用，连接、HTTP 都用不到）。
// 页面是哪一版（app/build-info.ts）要构建时的虚拟模块，这里换成假的。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import type { ConversationId } from "../../src/state/index.ts";
import { Composer, type ComposerMode, ComposerSlot } from "../../src/ui/conversation/Composer.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};
/** 不连线的 StoreProvider 的参数（子元素另传） */
const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;
const inStore = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(StoreProvider, offline, child));

const composer = (mode: ComposerMode, conversation: ConversationId = mode === "secretary" ? "secretary" : "maintainer:tm-1") =>
  inStore(createElement(Composer, { conversation, mode, onSend: noop }));

/** 会话组件底部那一格（Conversation.tsx 交 readOnly 给它）：任务会话 */
const slot = (readOnly: boolean) =>
  inStore(createElement(ComposerSlot, { readOnly, readOnlyNote: "任务已结束", conversation: "maintainer:tm-1", mode: "maintainer", onSend: noop }));

const ATTACH_BUTTON = '<button type="button" class="icon-btn attach-btn" aria-label="附件" aria-expanded="false">';

describe("输入框的＋", () => {
  test("秘书的输入框有＋", () => {
    expect(composer("secretary")).toContain(ATTACH_BUTTON);
  });

  test("任务和项目的维护者会话的输入框也有＋，和秘书的是同一个按钮", () => {
    expect(composer("maintainer", "maintainer:tm-1")).toContain(ATTACH_BUTTON);
    expect(composer("maintainer", "maintainer:pm-1")).toContain(ATTACH_BUTTON);
    // 选文件的框也在（菜单里点图片、文件时打开它）
    expect(composer("maintainer")).toContain('<input type="file" multiple="" hidden=""/>');
  });

  test("只读的维护者会话：没有输入框，也就没有＋，换成一行说明", () => {
    const html = slot(true);
    expect(html).toBe('<div class="composer composer-note muted">任务已结束</div>');
    expect(html).not.toContain("attach-btn");
  });

  test("能发消息的维护者会话（会话组件底部同一格）有＋", () => {
    expect(slot(false)).toContain(ATTACH_BUTTON);
  });
});
