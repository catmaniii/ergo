// 设置 · 浏览与填框里"授权的文件夹"那一节怎么画（138 号票，ui/authorized-folders.tsx）：用 React 在 Node 里渲染出来查。
// - 一行一个文件夹、右边一个叉（存着时叉灰掉），找不到了的标出来；没有的、还在取的各一句；
// - 选文件夹的框：常用位置和各个盘、子文件夹、"上一级"、底部当前路径和"授权这个文件夹"、贴完整路径；已授权的标出来；
//   读不了的写原因，列不全的写一共几个。点了做什么见 test/app/authorized-folders.test.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { FolderPickerState } from "../../src/app/authorized-folders.ts";
import type { LocalFolder } from "../../src/state/index.ts";
import { FolderPickerBody, FolderRows } from "../../src/ui/authorized-folders.tsx";

const PICTURES = "C:\\Users\\me\\Pictures";
const TRIP = "C:\\Users\\me\\Pictures\\2026 杭州";
const noop = () => {};

const rows = (folders: readonly LocalFolder[] | undefined, saving = false) => renderToStaticMarkup(createElement(FolderRows, { folders, saving, onRemove: noop }));

const picker = (state: Partial<FolderPickerState>, folders: readonly LocalFolder[] = []) =>
  renderToStaticMarkup(
    createElement(FolderPickerBody, {
      picker: { loading: false, draft: "", busy: false, ...state },
      folders,
      onBrowse: noop,
      onUp: noop,
      onAuthorize: noop,
      onDraft: noop,
      onAuthorizeDraft: noop,
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

describe("添加文件夹的框", () => {
  test("刚打开：常用位置和各个盘一排，已授权的标出来；还没点进文件夹时上一级灰掉、没有“授权这个文件夹”，能贴完整路径", () => {
    const html = picker({ roots: ROOTS }, [{ path: `${PICTURES}\\`, exists: true }]);
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
      [{ path: TRIP, exists: true }],
    );
    expect(html).toContain(`class="af-place on" title="${PICTURES}"`);
    expect(html).toContain('<button type="button" class="btn af-up">上一级</button>');
    expect(html).toContain('<button type="button" class="af-entry"><span class="af-entry-name">2025</span></button>');
    expect(html).toContain('<button type="button" class="af-entry"><span class="af-entry-name">2026 杭州</span><span class="af-tag">已授权</span></button>');
    expect(html).toContain(`<span class="af-path"><span class="muted">当前：</span>${PICTURES}</span><button type="button" class="btn primary">授权这个文件夹</button>`);
  });

  test("当前文件夹已经授权了：按钮写已授权、灰掉；在授权时写授权中；失败的原因写在框里", () => {
    const current = { kind: "folder" as const, path: PICTURES, folders: [], total: 0 };
    expect(picker({ roots: ROOTS, current }, [{ path: PICTURES, exists: true }])).toContain('<button type="button" class="btn primary" disabled="">已授权</button>');
    expect(picker({ roots: ROOTS, current, busy: true })).toContain('<button type="button" class="btn primary" disabled="">授权中…</button>');
    expect(picker({ roots: ROOTS, current })).toContain("这里面没有文件夹");
    expect(picker({ roots: ROOTS, draft: "D:\\没有", error: "这台电脑上没有这个文件夹：D:\\没有" })).toContain('<div class="sys-note">这台电脑上没有这个文件夹：D:\\没有</div>');
  });

  test("读不了的写原因（没有“授权这个文件夹”）；列不全的写一共几个", () => {
    const unreadable = picker({ roots: ROOTS, current: { kind: "unreadable", path: "C:\\System", parent: "C:\\", reason: "没有权限读这个文件夹" } });
    expect(unreadable).toContain("读不了 C:\\System：没有权限读这个文件夹");
    expect(unreadable).not.toContain("授权这个文件夹");
    const many = picker({ roots: ROOTS, current: { kind: "folder", path: "D:\\", folders: [{ name: "a", path: "D:\\a" }], total: 900 } });
    expect(many).toContain("一共 900 个文件夹，只列了前 1 个");
  });
});
