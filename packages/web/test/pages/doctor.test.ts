// 设置 · 更多 · 体检（319 号票的 319b，pages/more/DoctorPage.tsx + app/doctor.ts）：用 React 在 Node 里渲染出来查——
// - 八项一行一项：✅ / ⚠️、名字、事实（端口号、版本号、剩多少 GB 都按当前语言拼）、坏了的时候一句"怎么修"；
// - 查不了的那一项（fix 是 doctor.fix.retry）写"这次没查出来"，不拿空值（0 GB）去拼句子；
// - 演示页的假数据：六项好的、组件和外网入口两项坏的；
// - "再查一遍"重新发请求（loadDoctor：点一次取一次；演示页不请求网络）；
// - 页面右上的按钮、英文、界面上不出现"秘书""待我处理"。
// 设置列表里的位置见 settings-groups.test.ts；页面打得开见 page-opens.test.ts。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { demoDoctorView, loadDoctor } from "../../src/app/doctor.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { DoctorCheckRow, DoctorList, DoctorPage } from "../../src/pages/more/DoctorPage.tsx";
import { activeLocale, activeLocaleFrom, DOCTOR_CHECKS, type DoctorCheckDataById, type DoctorCheckId, type DoctorView, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};

/** 八项都健康时各查出来的（和守护进程回的一个形状） */
const GOOD: { [Id in DoctorCheckId]: DoctorCheckDataById[Id] } = {
  ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
  node: { running: "22.23.4", expected: "22" },
  pi: { version: "1.0.4" },
  supervisor: { running: true, port: 7420 },
  model: { configured: true },
  components: { missing: [] },
  disk: { freeGb: 42.3, totalGb: 476.8, path: "C:\\Users\\demo\\.ergo" },
  external: { configured: true, kind: "tailscale" },
};

const okView = (): DoctorView => ({ checks: DOCTOR_CHECKS.map((id) => ({ id, ok: true, data: GOOD[id] })), at: "2026-10-28T09:30:00.000Z" });

/** 只把这一项换掉（ok 默认按"不健康"，fix 是这一项的修法） */
function viewWith(id: DoctorCheckId, data: DoctorCheckDataById[DoctorCheckId], ok = false, fix = `doctor.fix.${id}`): DoctorView {
  const base = okView();
  return { ...base, checks: base.checks.map((check) => (check.id === id ? { id, ok, data, ...(ok ? {} : { fix }) } : check)) };
}

const render = (view: DoctorView) => renderToStaticMarkup(createElement(DoctorList, { view }));

const before = activeLocale();
afterEach(() => setActiveLocale(before));

describe("八项一行一项", () => {
  test("八项按协议的先后渲染，每项一个 data-check：✅、名字、事实", () => {
    const html = render(okView());
    for (const id of DOCTOR_CHECKS) expect(html).toContain(`data-check="${id}"`);
    // 顺序照 DOCTOR_CHECKS
    const order = [...html.matchAll(/data-check="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([...DOCTOR_CHECKS]);
    // 名字
    for (const title of ["端口", "Node 版本", "pi 版本", "服务管家", "模型的 Key", "组件", "磁盘空间", "外网入口"]) expect(html).toContain(title);
    // 好的全是 ✅，没有"怎么修"
    expect(html.match(/✅/g)).toHaveLength(8);
    expect(html).not.toContain("⚠️");
    expect(html).not.toContain("doctor-fix");
  });

  test("每项的事实是按当前语言拼出来的句子：端口号、版本号、端口、缺哪个功能、剩多少 GB、外网是哪一种", () => {
    const html = render(okView());
    expect(html).toContain("本机端口 8810：在听，是二狗自己；外网端口 8811：在听，是二狗自己");
    expect(html).toContain("运行的是 Node 22.23.4；pi 那条线是 22");
    expect(html).toContain("读到的版本是 1.0.4");
    expect(html).toContain("有回应（端口 7420）");
    expect(html).toContain("Key 配好了");
    expect(html).toContain("该装的都装好了");
    expect(html).toContain("数据目录 C:\\Users\\demo\\.ergo 所在卷还剩 42.3 GB（一共 476.8 GB）");
    expect(html).toContain("配了：Tailscale");
  });

  test("坏的那项：⚠️ + 一句怎么修（文案键取出来的整句）；别的项照旧 ✅、没有修法", () => {
    const html = render(viewWith("ports", { local: 8810, external: 8811, localUp: true, externalUp: false }));
    expect(html.match(/⚠️/g)).toHaveLength(1);
    expect(html.match(/✅/g)).toHaveLength(7);
    expect(html).toContain("本机端口 8810：在听，是二狗自己；外网端口 8811：没人在听");
    // 修法是 doctor.json 里的整句，不是键名
    expect(html).toContain("看看这两个端口被谁占着");
    expect(html).not.toContain("doctor.fix");
  });

  test("缺组件、没配外网入口：写着缺什么、只在本机用", () => {
    const missing = render(viewWith("components", { missing: ["memory.semantic", "voice.input"] }));
    expect(missing).toContain("还缺：按意思检索素材和按住说话");
    const noExternal = render(viewWith("external", { configured: false }));
    expect(noExternal).toContain("没配（只在本机用）");
  });

  test("查不了的那一项（fix 是 doctor.fix.retry）：写\"这次没查出来\"，不拿空值（0 GB）拼句子，修法说的是再查一遍", () => {
    const html = render(viewWith("disk", { freeGb: 0, totalGb: 0, path: "" }, false, "doctor.fix.retry"));
    expect(html).toContain("这次没查出来");
    expect(html).not.toContain("0 GB");
    expect(html).toContain("点「再查一遍」");
    expect(html).not.toContain("doctor.fix");
  });
});

describe("演示页的假数据", () => {
  test("八项、六项好的、组件和外网入口两项坏的（各带修法）", () => {
    const demo = demoDoctorView();
    expect(demo.checks.map((check) => check.id)).toEqual([...DOCTOR_CHECKS]);
    expect(demo.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual(["components", "external"]);
    for (const check of demo.checks) expect(check.fix).toBe(check.ok ? undefined : `doctor.fix.${check.id}`);
    const html = render(demo);
    expect(html.match(/✅/g)).toHaveLength(6);
    expect(html.match(/⚠️/g)).toHaveLength(2);
    expect(html).toContain("还缺：按意思检索素材");
    expect(html).toContain("去设置 · 组件装上缺的那几个");
  });
});

describe("点\"再查一遍\"重新发请求", () => {
  test("点一次取一次：loadDoctor 不走演示页时每次都发请求，拿回来的是新的一份", async () => {
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? demoDoctorView() : okView());
    };
    const first = await loadDoctor(false, fetcher);
    expect(first.checks.filter((check) => !check.ok)).toHaveLength(2);
    const second = await loadDoctor(false, fetcher);
    expect(calls).toBe(2);
    expect(second.checks.every((check) => check.ok)).toBe(true);
    expect(second.at).toBe("2026-10-28T09:30:00.000Z");
  });

  test("演示页不请求网络：给的是编好的数据", async () => {
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.resolve(okView());
    };
    const view = await loadDoctor(true, fetcher);
    expect(calls).toBe(0);
    expect(view.checks).toHaveLength(DOCTOR_CHECKS.length);
  });
});

describe("页面", () => {
  test("标题栏右上是\"再查一遍\"（演示页里拿的是编好的数据），底下列出八项和查的时刻", () => {
    // 演示页：直接打开构建产物（file://）时的那一种；Node 里没有 window，这里放一个够用的
    vi.stubGlobal("window", { location: { protocol: "file:" } });
    try {
      const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;
      const html = renderToStaticMarkup(createElement(StoreProvider, offline, createElement(DoctorPage, { title: "体检", onBack: noop })));
      expect(html).toContain('data-action="recheck"');
      expect(html).toContain("再查一遍");
      expect(html).toContain("查的都是本机的东西");
      expect(html).toContain("查的时刻：");
      for (const id of DOCTOR_CHECKS) expect(html).toContain(`data-check="${id}"`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("英文也有，界面文字不出现秘书 / 待我处理", () => {
  test("英文：名字、事实、修法都是英文，不是键名", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const html = render(okView());
    for (const title of ["Ports", "Node version", "pi version", "Service manager", "Model key", "Components", "Disk space", "Outside access"]) expect(html).toContain(title);
    expect(html).toContain("Local port 8810: listening, and it");
    expect(html).toContain("outside port 8811: listening, and it");
    expect(html).toContain("The volume holding the data folder C:\\Users\\demo\\.ergo has 42.3 GB free (of 476.8 GB)");
    const broken = render(viewWith("model", { configured: false }));
    expect(broken).toContain("No key yet");
    expect(broken).toContain("Put a DeepSeek key in Settings · Models");
    expect(broken).not.toContain("doctor.");
  });

  test("中文界面上不出现\"秘书\"\"待我处理\"", () => {
    const html = render(demoDoctorView()) + renderToStaticMarkup(createElement(DoctorCheckRow, { check: demoDoctorView().checks[0]! }));
    expect(html).not.toMatch(/秘书|待我处理/);
  });
});
