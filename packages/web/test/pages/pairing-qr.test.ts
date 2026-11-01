// 设置 · 设备配对 · 配对二维码（pages/more/PairingQrPage.tsx、ui/qr-code.tsx、app/connection-addresses.ts）：
// - 二维码真的扫得出：生成的方阵按 QR 规范解一遍（qr-decode.ts，不经库的代码）比对内容；ZXing 那边在 frontend/android 的 JVM 单测和联调里；
// - 有地址：大二维码、地址、等手机扫码；多个地址能切换；打不通的标明，tailnet 写明手机要先连上；
// - 没地址：不显示二维码，写清楚连不上，两条路（服务管家的链接只在本机给）；老服务管家说一声；
// - 配对请求就在这个界面上批准、拒绝，批准后写连好了；
// - 界面上不出现"秘书""待我处理"，英文一个中文字都没有。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";
import { addressNotes, demoConnectionAddressesView, manualAddressProblem } from "../../src/app/connection-addresses.ts";
import { doctorFactText, doctorFixText } from "../../src/app/doctor.ts";
import { bundledLocale } from "../../src/app/locale.ts";
import { PairingQrContent } from "../../src/pages/more/PairingQrPage.tsx";
import { activeLocale, activeLocaleFrom, type Card, type CardState, type ConnectionAddressesView, pendingPairingCardIds, setActiveLocale, t } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";
import { initialUiState } from "../../src/state/ui-state.ts";
import { QrCode } from "../../src/ui/qr-code.tsx";
import { qrMatrix, qrPath } from "../../src/util/qr.ts";
import { decodeQrMatrix } from "./qr-decode.ts";

const before = activeLocale();
afterEach(() => setActiveLocale(before));

const VIEW: ConnectionAddressesView = {
  addresses: [
    { kind: "public", url: "https://ergo.example.com/", reachable: true },
    { kind: "tailnet", url: "https://ergo.tail.example.com/", reachable: null },
    { kind: "manual", url: "https://frp.example.com:8443/", reachable: null },
  ],
  manual: "https://frp.example.com:8443/",
  manager: "supported",
  managerUrl: "http://127.0.0.1:7420/",
  rejected: [],
};
const NONE: ConnectionAddressesView = { addresses: [], manager: "supported", managerUrl: "http://127.0.0.1:7420/", rejected: [] };

function render(props: Partial<ComponentProps<typeof PairingQrContent>>): string {
  return renderToStaticMarkup(
    createElement(PairingQrContent, { view: VIEW, error: undefined, local: true, requests: [], onCard: () => {}, onSaveManual: async () => undefined, ...props }),
  );
}

const pairingCard = (over: Partial<Card> = {}): CardState => ({
  card: {
    id: "card-1",
    type: "pairing",
    typeVersion: 1,
    status: "pending",
    text: "",
    createdAt: "2026-11-01T00:00:00.000Z",
    version: 1,
    payload: { deviceName: "我的手机", shortCode: "123456", fingerprint: "abcd1234", from: "经隧道 · 203.0.113.9", expiresAt: "2026-11-01T00:05:00.000Z" },
    ...over,
  } as Card,
});

describe("二维码真的扫得出", () => {
  test.each([
    "https://ergo.example.com/",
    "https://ergo.tail1234.ts.net/",
    "https://a-rather-long-subdomain.of-a-very-long-domain-name.example.com:8443/some/path?x=1",
    "http://127.0.0.1:18811/",
    `https://${"x".repeat(150)}.example.com/`,
  ])("解一遍和原文一样：%s", (url) => {
    expect(decodeQrMatrix(qrMatrix(url))).toBe(url);
  });

  test("非 ASCII 的按 UTF-8 编，解出来不乱码", () => {
    expect(decodeQrMatrix(qrMatrix("https://二狗.example.com/"))).toBe("https://二狗.example.com/");
  });

  test("画出来的路径和方阵对得上：黑块格数一样；四周留了 4 格白边", () => {
    const matrix = qrMatrix("https://ergo.example.com/");
    const dark = matrix.flat().filter(Boolean).length;
    let drawn = 0;
    let minX = Infinity;
    let minY = Infinity;
    for (const [, x, y, w] of qrPath(matrix).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      drawn += Number(w);
      minX = Math.min(minX, Number(x));
      minY = Math.min(minY, Number(y));
    }
    expect(drawn).toBe(dark);
    expect([minX, minY]).toEqual([4, 4]);
  });

  test("永远白底黑块，不跟风格的颜色走（反色的码相机读不出来）", () => {
    const html = renderToStaticMarkup(createElement(QrCode, { text: "https://ergo.example.com/", label: "x" }));
    expect(html).toContain('fill="#fff"');
    expect(html).toContain('fill="#000"');
    expect(html).toContain('role="img"');
  });
});

describe("有地址", () => {
  test("大二维码（用排第一的）、下面写着地址、等手机扫码", () => {
    const html = render({});
    expect(html).toContain('data-qr-text="https://ergo.example.com/"');
    expect(html).toContain(t("pages.devices.qr.waiting"));
    expect(html).toContain(t("pages.devices.qr.kind.public"));
    expect(html).toContain(t("pages.devices.qr.state.reachable"));
  });

  test("二维码里只有地址，没有口令之类的东西", () => {
    const text = /data-qr-text="([^"]*)"/.exec(render({}))![1]!;
    expect(new URL(text).search).toBe("");
    expect(new URL(text).hash).toBe("");
    expect(text).toBe("https://ergo.example.com/");
  });

  test("有多个地址时能切换：每个都列出来，手填的也在；只有一个时没有切换这一块", () => {
    const html = render({});
    expect(html).toContain(t("pages.devices.qr.switch"));
    for (const address of VIEW.addresses) expect(html).toContain(address.url);
    expect(html).toContain('aria-pressed="true"');
    const one = render({ view: { ...VIEW, addresses: VIEW.addresses.slice(0, 1) } });
    expect(one).not.toContain(t("pages.devices.qr.switch"));
  });

  test("打不通的标明但仍然列出，Tailnet 写明手机要先连上；手填的不写没测过（手机扫的时候会真的测）", () => {
    expect(addressNotes({ kind: "public", url: "https://x/", reachable: false })).toEqual([t("pages.devices.qr.state.unreachable")]);
    expect(addressNotes({ kind: "tailnet", url: "https://x/", reachable: true })).toEqual([t("pages.devices.qr.state.reachable"), t("pages.devices.qr.tailnetNote")]);
    expect(addressNotes({ kind: "manual", url: "https://x/", reachable: null })).toEqual([]);
    expect(addressNotes({ kind: "public", url: "https://x/", reachable: null })).toEqual([t("pages.devices.qr.state.untested")]);
    const html = render({ view: { ...VIEW, addresses: [{ kind: "tailnet", url: "https://ergo.tail.example.com/", reachable: false }] } });
    expect(html).toContain(t("pages.devices.qr.tailnetNote"));
    expect(html).toContain(t("pages.devices.qr.state.unreachable"));
    expect(html).toContain("<svg");
  });

  test("服务管家给了但用不了的入口：说一声去体检看", () => {
    const html = render({ view: { ...VIEW, rejected: [{ kind: "tailnet", url: "https://x/", reason: "wrong_port", port: 8810 }] } });
    expect(html).toContain(t("pages.devices.qr.rejected", { count: 1 }));
  });
});

describe("没地址", () => {
  test("不显示二维码，写清楚连不上，两条路：去服务管家（给链接，公网隧道和 tailnet 都行）、填一个自己的地址", () => {
    const html = render({ view: NONE });
    expect(html).not.toContain("<svg");
    expect(html).toContain(t("pages.devices.qr.none.title"));
    expect(html).toContain(t("pages.devices.qr.none.managerTitle"));
    expect(html).toContain(t("pages.devices.qr.none.managerBody"));
    expect(html).toContain('href="http://127.0.0.1:7420/"');
    expect(html).toContain(t("pages.devices.qr.none.manualTitle"));
    expect(html).toContain('type="url"');
    expect(html).not.toContain(t("pages.devices.qr.waiting"));
  });

  test("在手机上看：服务管家的链接打不开，改成说在电脑上打开", () => {
    const html = render({ view: NONE, local: false });
    expect(html).not.toContain("<a ");
    expect(html).toContain(t("pages.devices.qr.none.managerOnComputer", { url: "http://127.0.0.1:7420/" }));
  });

  test("老服务管家：说一声要升级才能自动列出来，手填照样能用；二狗不是它拉起的：没有链接", () => {
    const old = render({ view: { ...NONE, manager: "unsupported" } });
    expect(old).toContain(t("pages.devices.qr.none.managerOld"));
    expect(old).toContain('type="url"');
    const noManager = render({ view: { addresses: [], manager: "disabled", rejected: [] } });
    expect(noManager).toContain(t("pages.devices.qr.none.managerUnknown"));
    expect(noManager).not.toContain("<a ");
  });

  test("还没取到、取不到", () => {
    expect(render({ view: undefined })).toContain(t("pages.devices.qr.loading"));
    expect(render({ view: undefined, error: "断了" })).toContain(t("pages.devices.qr.loadFailed", { reason: "断了" }));
  });
});

describe("配对请求就在这个界面上", () => {
  test("设备名、短码、短指纹和批准、拒绝按钮；二维码还在", () => {
    const html = render({ requests: [pairingCard()] });
    expect(html).toContain("我的手机");
    expect(html).toContain(t("pages.pairing.approve.approve"));
    expect(html).toContain(t("pages.pairing.approve.deny"));
    expect(html).toContain("123 456");
    expect(html).toContain("<svg");
    // 请求排在二维码上面：手机上不用往下翻
    expect(html.indexOf("我的手机")).toBeLessThan(html.indexOf("<svg"));
  });

  test("批准后写连好了；拒绝、过期各有各的说法，都不再有按钮", () => {
    const approved = render({ requests: [pairingCard({ status: "handled", outcome: { action: "approve" } } as Partial<Card>)] });
    expect(approved).toContain(t("pages.devices.qr.request.connected", { name: "我的手机" }));
    expect(approved).not.toContain(t("pages.pairing.approve.approve"));
    const denied = render({ requests: [pairingCard({ status: "handled", outcome: { action: "deny" } } as Partial<Card>)] });
    expect(denied).toContain(t("pages.devices.qr.request.denied", { name: "我的手机" }));
    const expired = render({ requests: [pairingCard({ status: "expired" } as Partial<Card>)] });
    expect(expired).toContain(t("pages.devices.qr.request.expired", { name: "我的手机" }));
  });

  test("哪些请求算在等批准：只算配对卡、没过期、还 pending 的，按来的先后", () => {
    const now = Date.parse("2026-11-01T00:01:00.000Z");
    const cards: Record<string, CardState> = {
      b: pairingCard({ id: "b", createdAt: "2026-11-01T00:00:30.000Z" }),
      a: pairingCard({ id: "a" }),
      done: pairingCard({ id: "done", status: "handled" } as Partial<Card>),
      old: pairingCard({ id: "old", payload: { deviceName: "x", shortCode: "1", fingerprint: "2", from: "3", expiresAt: "2026-11-01T00:00:30.000Z" } } as Partial<Card>),
      other: pairingCard({ id: "other", type: "plan" } as Partial<Card>),
    };
    expect(pendingPairingCardIds({ ...initialUiState, cards }, now)).toEqual(["a", "b"]);
  });
});

describe("体检：服务管家给了、手机用不了的入口", () => {
  test("点名写出来：接错了端口、不是 https；修法是专门的那条", () => {
    const check = {
      id: "external" as const,
      ok: false,
      fix: "doctor.fix.externalRejected",
      data: {
        configured: true,
        kind: "tunnel" as const,
        rejected: [
          { kind: "tailnet" as const, url: "https://leak.example.com/", reason: "wrong_port" as const, port: 8810 },
          { kind: "public" as const, url: "http://plain.example.com/", reason: "not_https" as const, port: 8811 },
        ],
      },
    };
    const fact = doctorFactText(check);
    expect(fact).toContain("https://leak.example.com/");
    expect(fact).toContain("8810");
    expect(fact).toContain("http://plain.example.com/");
    expect(doctorFixText(check)).toBe(t("doctor.fix.externalRejected"));
  });

  test("没有用不了的入口：说法和原来一样；手填的地址算依据", () => {
    expect(doctorFactText({ id: "external", ok: true, data: { configured: true, kind: "manual" } })).toBe(t("doctor.fact.external", { kind: t("doctor.kind.manual") }));
  });
});

describe("手填的校验、演示数据、文案", () => {
  test("填的地址不对当场说，对的不说", () => {
    expect(manualAddressProblem("https://frp.example.com/")).toBeUndefined();
    expect(manualAddressProblem("https://192.168.1.5/")).toBe(t("protocol.connectionAddress.invalid.lan"));
    expect(manualAddressProblem("http://frp.example.com/")).toBe(t("protocol.connectionAddress.invalid.httpsOnly"));
    expect(manualAddressProblem("")).toBe(t("protocol.connectionAddress.invalid.empty"));
  });

  test("校验不过的话在网页打包的语言里：页面上是句子，不是键名", () => {
    // 这个文件平时用的词典是直接读全部语言文件的（setup-locales.ts），守护进程才有的句子也查得到；页面上只有打包进去的这份
    const reasons = ["", `https://${"a".repeat(600)}.example.com/`, "not an address", "https://", "https://me:pw@frp.example.com/", "http://frp.example.com/", "https://192.168.1.5/"];
    for (const language of ["zh-CN", "en"]) {
      setActiveLocale(bundledLocale(language));
      for (const input of reasons) {
        const problem = manualAddressProblem(input);
        expect(problem).toBeDefined();
        expect(problem).not.toMatch(/^[A-Za-z]+(\.[A-Za-z]+)+$/);
      }
    }
    setActiveLocale(bundledLocale("zh-CN"));
    expect(manualAddressProblem("https://192.168.1.5/")).toContain("局域网");
    setActiveLocale(bundledLocale("en"));
    expect(manualAddressProblem("https://192.168.1.5/")).toContain("local network");
  });

  test("演示页的假数据：两个地址，填了手填的多一个", () => {
    expect(demoConnectionAddressesView().addresses.map((a) => a.kind)).toEqual(["public", "tailnet"]);
    expect(demoConnectionAddressesView("https://frp.example.com/").addresses.map((a) => a.kind)).toEqual(["public", "tailnet", "manual"]);
  });

  test("界面上不出现内部词；英文一个中文字都没有", () => {
    const all = [render({}), render({ view: NONE }), render({ view: NONE, local: false }), render({ requests: [pairingCard()] })].join("");
    expect(all).not.toMatch(/秘书|待我处理|负责人/);
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    for (const html of [render({}), render({ view: NONE }), render({ view: { ...NONE, manager: "unsupported" }, local: false })]) {
      expect(html).not.toMatch(/[一-鿿]/);
    }
  });
});
