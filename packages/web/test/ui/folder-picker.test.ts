// 选本机文件夹的框怎么画（ui/folder-picker.tsx，463 号票从授权的文件夹里拆出来、几处共用）：用 React 在 Node 里渲染出来查。
// - 常用位置和各个盘、子文件夹、"上一级"、底部当前路径和选这个文件夹的按钮、贴完整路径；读不了的写原因，列不全的写一共几个；
// - 按钮上的字调用方能换（授权的文件夹写"授权这个文件夹""授权"），不换的写"用这个文件夹""用这个路径"；
// - 调用方要标出来的带小标签：标成 done 的（已授权）当前文件夹是它时按钮写标签、灰掉；别的（⚙ 里的"已登记""所有 agent 可读"）
//   跟在当前路径后面，按钮照样能点；
// - ⚙ 里目录授权那一块：说明下面一句提醒（所有 agent 都能读的在设置 · 目录授权最上面，带链接），登记表单的目录旁边"选文件夹…"。
// 点了做什么见 test/app/folder-picker.test.ts。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import type { FolderPickerState } from "../../src/app/folder-picker.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { type FolderGrantsView, type FolderMark, folderGrantPickerMarks } from "../../src/state/index.ts";
import { FolderGrantForm, FolderGrantsBlock } from "../../src/ui/folder-grants.tsx";
import { FolderPickerBody, type FolderPickerLabels } from "../../src/ui/folder-picker.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const PICTURES = "C:\\Users\\me\\Pictures";
const TRIP = "C:\\Users\\me\\Pictures\\2026 杭州";
const noop = () => {};

/** 授权的文件夹那一节给的字 */
const AUTHORIZE: FolderPickerLabels = { here: "授权这个文件夹", busy: "授权中…", paste: "授权" };
const authorized = (...paths: string[]): FolderMark[] => [{ paths, label: "已授权", done: true }];

const picker = (state: Partial<FolderPickerState>, marks: readonly FolderMark[] = [], labels: Partial<FolderPickerLabels> | undefined = AUTHORIZE) =>
  renderToStaticMarkup(
    createElement(FolderPickerBody, {
      picker: { loading: false, draft: "", busy: false, ...state },
      marks,
      labels,
      onBrowse: noop,
      onUp: noop,
      onChoose: noop,
      onDraft: noop,
      onChooseDraft: noop,
    }),
  );

const ROOTS: FolderPickerState["roots"] = {
  places: [
    { name: "图片", path: PICTURES },
    { name: "用户目录", path: "C:\\Users\\me" },
  ],
  drives: [
    { name: "C:", path: "C:\\" },
    { name: "D:", path: "D:\\" },
  ],
};

const folder = (path: string, name: string) => ({ name, path });

const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;
const inStore = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(StoreProvider, offline, child));

describe("选文件夹的框（授权的文件夹用的字）", () => {
  test("刚打开：常用位置和各个盘一排，已授权的标出来；还没点进文件夹时上一级灰掉、没有“授权这个文件夹”，能贴完整路径", () => {
    const html = picker({ roots: ROOTS }, authorized(`${PICTURES}\\`));
    expect(html).toContain(`<button type="button" class="af-place" title="${PICTURES}">图片<span class="af-tag">已授权</span></button>`);
    expect(html).toContain('<button type="button" class="af-place af-drive">C:</button>');
    expect(html).toContain('<button type="button" class="af-place af-drive">D:</button>');
    expect(html).toContain('<button type="button" class="btn af-up" disabled="">上一级</button>');
    expect(html).toContain("点上面的位置或盘开始");
    expect(html).not.toContain("授权这个文件夹");
    expect(html).toContain('placeholder="或者贴一个完整路径，比如 D:\\照片"');
    // 没贴路径时“授权”灰掉
    expect(html).toContain('<button type="button" class="btn" disabled="">授权</button>');
  });

  test("点进一个文件夹：子文件夹一个一个（已授权的标出来）、上一级能点，底部当前路径和“授权这个文件夹”", () => {
    const html = picker(
      {
        roots: ROOTS,
        current: { kind: "folder", path: PICTURES, parent: "C:\\Users\\me", folders: [{ name: "2025", path: `${PICTURES}\\2025` }, { name: "2026 杭州", path: TRIP }], total: 2 },
      },
      authorized(TRIP),
    );
    expect(html).toContain(`class="af-place on" title="${PICTURES}"`);
    expect(html).toContain('<button type="button" class="btn af-up">上一级</button>');
    expect(html).toContain('<button type="button" class="af-entry"><span class="af-entry-name">2025</span></button>');
    expect(html).toContain('<button type="button" class="af-entry"><span class="af-entry-name">2026 杭州</span><span class="af-tag">已授权</span></button>');
    expect(html).toContain(`<span class="af-path"><span class="muted">当前：</span>${PICTURES}</span><button type="button" class="btn primary">授权这个文件夹</button>`);
  });

  test("当前文件夹已经授权了：按钮写已授权、灰掉；在授权时写授权中；失败的原因写在框里", () => {
    const current = { kind: "folder" as const, path: PICTURES, folders: [], total: 0 };
    expect(picker({ roots: ROOTS, current }, authorized(PICTURES))).toContain('<button type="button" class="btn primary" disabled="">已授权</button>');
    expect(picker({ roots: ROOTS, current, busy: true })).toContain('<button type="button" class="btn primary" disabled="">授权中…</button>');
    expect(picker({ roots: ROOTS, current })).toContain("这里面没有文件夹");
    expect(picker({ roots: ROOTS, draft: "D:\\没有", error: "这台电脑上没有这个文件夹：D:\\没有" })).toContain('<div class="sys-note">这台电脑上没有这个文件夹：D:\\没有</div>');
  });

  test("读不了的写原因（没有“授权这个文件夹”）；列不全的写一共几个；列不出常用位置的写一句", () => {
    const unreadable = picker({ roots: ROOTS, current: { kind: "unreadable", path: "C:\\System", parent: "C:\\", reason: "没有权限读这个文件夹" } });
    expect(unreadable).toContain("读不了 C:\\System：没有权限读这个文件夹");
    expect(unreadable).not.toContain("授权这个文件夹");
    const many = picker({ roots: ROOTS, current: { kind: "folder", path: "D:\\", folders: [{ name: "a", path: "D:\\a" }], total: 900 } });
    expect(many).toContain("一共 900 个文件夹，只列了前 1 个");
    expect(picker({ error: "守护进程连不上" })).toContain("列不出常用位置");
    expect(picker({ loading: true })).toContain("正在列……");
  });
});

describe("别处用：不换字、标的不是 done 的", () => {
  test("不换字的写“用这个文件夹”“用这个路径”", () => {
    const html = picker({ roots: ROOTS, current: { kind: "folder", path: PICTURES, folders: [], total: 0 }, draft: "D:\\笔记" }, [], {});
    expect(html).toContain('<button type="button" class="btn primary">用这个文件夹</button>');
    expect(html).toContain('<button type="button" class="btn">用这个路径</button>');
    expect(html).not.toContain("授权");
  });

  test("⚙ 里登记目录：这个 agent 登记了的标“已登记”，授权的文件夹标“所有 agent 可读”，两样都有的两个都标；跟在当前路径后面，按钮照样能点", () => {
    const view: FolderGrantsView = {
      grants: [
        { id: "g1", agentId: "secretary", path: "D:\\笔记", modes: ["read"], note: "", addedBy: "user", addedAt: "2026-10-20T09:00:00.000+08:00", state: "active" },
        { id: "g2", agentId: "secretary", path: "D:\\照片", modes: ["read", "write"], note: "", addedBy: "user", addedAt: "2026-10-20T09:00:00.000+08:00", state: "active" },
        { id: "g3", agentId: "project-a", path: "D:\\备份", modes: ["read"], note: "", addedBy: "user", addedAt: "2026-10-20T09:00:00.000+08:00", state: "active" },
      ],
      authorizedFolders: ["D:\\照片", "D:\\文档"],
    };
    const marks = folderGrantPickerMarks(view, "secretary");
    const html = picker(
      {
        roots: ROOTS,
        current: { kind: "folder", path: "D:\\照片", parent: "D:\\", folders: [], total: 0 },
      },
      marks,
      {},
    );
    expect(html).toContain('<span class="muted">当前：</span>D:\\照片<span class="fp-here-tags"><span class="af-tag">已登记</span><span class="af-tag">所有 agent 可读</span></span></span><button type="button" class="btn primary">用这个文件夹</button>');

    const list = picker(
      {
        roots: ROOTS,
        current: { kind: "folder", path: "D:\\", folders: [folder("D:\\照片", "照片"), folder("D:\\文档", "文档"), folder("D:\\笔记", "笔记"), folder("D:\\备份", "备份")], total: 4 },
      },
      marks,
      {},
    );
    expect(list).toContain('<span class="af-entry-name">文档</span><span class="af-tag">所有 agent 可读</span></button>');
    expect(list).toContain('<span class="af-entry-name">笔记</span><span class="af-tag">已登记</span></button>');
    // 别的 agent 登记的不标
    expect(list).toContain('<span class="af-entry-name">备份</span></button>');
  });

  test("还没取到这一份时什么都不标", () => {
    expect(folderGrantPickerMarks(undefined, "secretary").flatMap((m) => m.paths)).toEqual([]);
  });
});

describe("⚙ 里目录授权那一块", () => {
  test("说明下面一句提醒：所有 agent 都能读的在设置 · 目录授权最上面（链接过去），这里登记的只给这个 agent、可以勾写和删", () => {
    const html = inStore(createElement(FolderGrantsBlock, { agentId: "secretary", readOnly: false }));
    expect(html).toContain('<div class="fg-cross">所有 agent 都能读的文件夹在<a class="link fg-cross-link" href="#/more/folder-grants">设置 · 目录授权</a>最上面，那里的不用在这里再登记读；这里登记的只给这个 agent，可以勾写和删。</div>');
    expect(html).not.toContain("秘书");
  });

  test("登记一个目录的表单：目录输入框旁边“选文件夹…”，手填的输入框照旧", () => {
    const html = inStore(createElement(FolderGrantForm, { agentId: "secretary", view: { grants: [], authorizedFolders: [] }, onSaved: noop, onCancel: noop }));
    expect(html).toMatch(/<div class="fp-path-row"><input id="[^"]+" class="input" type="text" placeholder="完整路径，比如 D:\\笔记" value=""\/><button type="button" class="btn fp-open">选文件夹…<\/button><\/div>/);
  });
});
