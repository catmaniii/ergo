// 设置 · 目录授权里授权的文件夹那一节怎么画：用 React 在 Node 里渲染出来查。
// - 一行一个文件夹、右边一个叉（存着时叉灰掉），找不到了的标出来；没有的、还在取的各一句（ui/authorized-folders.tsx）；
// - 说明下面一句提醒：只放开读、对所有 agent，要写、删到项目、任务的 ⚙ 里单独授权，带跳到"各个 agent 的目录授权"的链接（463）。
// 选文件夹的框是几处共用的那一个，见 test/ui/folder-picker.test.ts；点了做什么见 test/app/authorized-folders.test.ts。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { AuthorizedFoldersSection } from "../../src/pages/more/AuthorizedFolders.tsx";
import type { LocalFolder } from "../../src/state/index.ts";
import { FolderRows } from "../../src/ui/authorized-folders.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const PICTURES = "C:\\Users\\me\\Pictures";
const noop = () => {};

const rows = (folders: readonly LocalFolder[] | undefined, saving = false) => renderToStaticMarkup(createElement(FolderRows, { folders, saving, onRemove: noop }));

describe("授权的文件夹：一行一个", () => {
  test("完整路径、右边一个叉；找不到了的标出来", () => {
    const html = rows([
      { path: PICTURES, exists: true },
      { path: "E:\\旧照片", exists: false },
    ]);
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toContain(`<span class="af-path">${PICTURES}</span>`);
    expect(html).toContain(`<button type="button" class="icon-btn af-remove" aria-label="拿掉 ${PICTURES}" title="拿掉">×</button>`);
    expect(html).toContain('<li class="af-row af-missing"><span class="af-path">E:\\旧照片</span><span class="af-tag af-tag-warn">找不到了</span>');
    expect(html.match(/找不到了/g)).toHaveLength(1);
  });

  test("存着时叉灰掉；没有的、还在取的各一句", () => {
    expect(rows([{ path: PICTURES, exists: true }], true)).toContain('title="拿掉" disabled="">×</button>');
    expect(rows([])).toBe('<div class="muted af-empty">还没有授权的文件夹</div>');
    expect(rows(undefined)).toContain("正在取");
  });
});

describe("授权的文件夹那一节的提醒", () => {
  test("只放开读、对所有 agent；要写、删到项目、任务（或个人助理）的 ⚙ 里单独授权；链接跳到各个 agent 的目录授权", () => {
    const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;
    const html = renderToStaticMarkup(createElement(StoreProvider, offline, createElement(AuthorizedFoldersSection, { onPerAgent: () => {} })));
    expect(html).toContain('<div class="fg-cross">这里只放开读，对所有 agent 都一样。要让某个项目或任务的负责人在别的目录里写、删，到那个项目、任务（或个人助理）的 ⚙ 里单独授权');
    expect(html).toContain('<button type="button" class="link fg-cross-link">看各个 agent 的目录授权</button></div>');
    expect(html).not.toContain("秘书");
  });
});
