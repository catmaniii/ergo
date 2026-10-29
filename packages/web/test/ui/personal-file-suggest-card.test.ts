// 候选核对卡（283 号票，ui/cards/PersonalFileSuggestCard.tsx）上从手机通讯录挑的人（299 号票）：用 React 在 Node 里渲染出来查——
// 建档那一条写"从手机通讯录挑的"（不写提到几次）；电话一位一位列在小格子里（照 281 的核对卡）；底下写"号码请一位一位对一遍"，
// 不写"从聊天里听来的"；界面上没有"秘书""待我处理"这些字。301 号票：导入的通讯录 vCard（origin vcard）建档写"从导入的通讯录来的"、
// 带关系的写在称呼后面，底下写明没勾的不再提、号码逐位核对。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { type CardState, type PersonalFileSuggestCardPayload, sourceVia } from "../../src/state/index.ts";
import { PersonalFileSuggestCard } from "../../src/ui/cards/PersonalFileSuggestCard.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;

const person = { name: "王小明", isNew: true };
const picked: PersonalFileSuggestCardPayload = {
  title: "核对一下：这几件要不要记进档案",
  date: "2026-10-25",
  items: [
    { id: "new:n:王小明", kind: "create", person, mentions: 0, heard: [], origin: "contacts" },
    { id: "pc-1", kind: "field", person, field: "phone", label: "电话", value: "13800001111", number: true, heard: [], origin: "contacts" },
    { id: "pc-2", kind: "field", person, field: "address", label: "地址", value: "某某路 1 号", number: false, heard: [], origin: "contacts" },
  ],
};

const render = (p: PersonalFileSuggestCardPayload) => {
  const state: CardState = { card: { id: "c-1", type: "personal_file_suggest", typeVersion: 1, version: 1, status: "pending", payload: p, text: "候选", createdAt: "2026-10-25T10:00:00+08:00" } };
  return renderToStaticMarkup(createElement(StoreProvider, offline, createElement(PersonalFileSuggestCard, { state, payload: p, done: false, act: () => {} })));
};

describe("候选核对卡上从手机通讯录挑的人", () => {
  test("建档写从手机通讯录挑的；电话一位一位列出；底下提醒逐位核对", () => {
    const html = render(picked);
    expect(html).toContain("建一份档案（从手机通讯录挑的）");
    expect(html).not.toContain("提到");
    expect(html).toContain('class="pf-digits"');
    expect(html.match(/class="pf-digit"/g)).toHaveLength(11);
    expect(html).toContain("地址：某某路 1 号");
    expect(html).toContain("号码请一位一位对一遍");
    expect(html).not.toContain("从聊天里听来的");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("301：导入的通讯录——建档写从导入的通讯录来的、关系写在称呼后面、纪念日照写；没勾的不再提、号码逐位核对", () => {
    const mom = { name: "张丽", relation: "母亲", isNew: true };
    const html = render({
      ...picked,
      items: [
        { id: "new:n:张丽", kind: "create", person: mom, mentions: 0, heard: [], origin: "vcard" },
        { id: "pc-3", kind: "field", person: mom, field: "anniversary:相识纪念日", label: "相识纪念日", value: "2015-06-30", number: false, heard: [], origin: "vcard" },
        { id: "pc-4", kind: "field", person: mom, field: "phone", label: "电话", value: "13900000002", number: true, heard: [], origin: "vcard" },
      ],
    });
    expect(html).toContain("张丽（母亲）");
    expect(html).toContain("建一份档案（从导入的通讯录来的）");
    expect(html).toContain("相识纪念日：2015-06-30");
    expect(html.match(/class="pf-digit"/g)).toHaveLength(11);
    expect(html).toContain("从导入的通讯录来的，勾了的才写进档案；没勾的以后不再提；号码请一位一位对一遍。");
    expect(html).not.toContain("从聊天里听来的");
    expect(html).not.toContain("从手机通讯录挑的");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("档案页上的出处：从导入的通讯录来的、你确认的", () => {
    expect(sourceVia({ via: "curator", basis: "confirmed", at: "2026-10-25T10:00:00+08:00", origin: "vcard" })).toBe("从导入的通讯录来的、你确认的");
    expect(sourceVia({ via: "curator", basis: "confirmed", at: "2026-10-25T10:00:00+08:00", origin: "contacts" })).toBe("从手机通讯录挑的、你确认的");
  });

  test("每晚整理的照旧：写提到几次、从聊天里听来的", () => {
    const html = render({ ...picked, items: [{ ...picked.items[0]!, mentions: 3, origin: "nightly" }] });
    expect(html).toContain("建一份档案（提到 3 次）");
    expect(html).toContain("从聊天里听来的");
  });
});
