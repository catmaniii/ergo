// 主切面的"新设备"：一台从外网（经隧道）访问二狗的设备，像浏览器一样带着自己的 cookie 访问守护进程的外网端口。
// - cookie 罐：响应里的 Set-Cookie 记下来（Max-Age=0 的删掉），之后的请求和 WebSocket 握手都带上；
// - 经隧道来的请求 TCP 对端都是本机，nginx 覆盖写 X-Real-IP：realIp 给了就每个请求都带上它。
import { type AccessInfo, type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, HTTP_PATHS, type PairingCardPayload, type PairingRequestView } from "@ergou/protocol";
import { expect } from "vitest";
import { DEVICE_COOKIE } from "../../src/pairing/credentials.ts";
import { type ConnectOptions, TestFrontend } from "./frontend.ts";
import { type BrowserHttpOptions, type BrowserHttpResult, httpRequest } from "./browser-http.ts";

export const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

export interface TestDeviceOptions {
  userAgent?: string;
  /** nginx 覆盖写的 X-Real-IP（经隧道的真实来源） */
  realIp?: string;
}

export class TestDevice {
  /** cookie 名 → 值 */
  readonly cookies = new Map<string, string>();
  readonly baseUrl: string;
  private readonly options: TestDeviceOptions;

  constructor(externalUrl: string, options: TestDeviceOptions = {}) {
    this.baseUrl = externalUrl;
    this.options = options;
  }

  /** 设备凭证（cookie 原值）；还没拿到是 undefined */
  get credential(): string | undefined {
    return this.cookies.get(DEVICE_COOKIE);
  }

  /** Cookie 请求头（cookie 罐里没东西时是 undefined） */
  get cookieHeader(): string | undefined {
    return this.cookies.size === 0 ? undefined : [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** 带着自己的 cookie、User-Agent 和 X-Real-IP 发一个请求，记下响应里的 Set-Cookie */
  async request(pathname: string, options: BrowserHttpOptions = {}): Promise<BrowserHttpResult> {
    const res = await httpRequest(this.baseUrl, pathname, {
      ...options,
      headers: {
        "user-agent": this.options.userAgent ?? IPHONE_UA,
        "x-real-ip": this.options.realIp,
        cookie: this.cookieHeader,
        ...options.headers,
      },
    });
    for (const c of res.setCookies) {
      if (c.attributes["max-age"] === "0") this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  /** 发起配对请求（设备名不给就由守护进程按 User-Agent 生成） */
  requestPairing(deviceName?: string): Promise<BrowserHttpResult> {
    return this.request(HTTP_PATHS.pairing, { method: "POST", body: deviceName === undefined ? {} : { deviceName } });
  }

  /** 问一次自己这个配对请求的状态（已批准就在这次响应里领到凭证） */
  async pollPairing(): Promise<PairingRequestView> {
    const res = await this.request(HTTP_PATHS.pairing);
    if (res.status !== 200) throw new Error(`查配对请求失败：HTTP ${res.status} ${res.body}`);
    return res.json<{ request: PairingRequestView }>().request;
  }

  /** 在新设备上改设备名 */
  renamePairing(deviceName: string): Promise<BrowserHttpResult> {
    return this.request(HTTP_PATHS.pairing, { method: "PATCH", body: { deviceName } });
  }

  async access(): Promise<AccessInfo> {
    return (await this.request(HTTP_PATHS.access)).json<AccessInfo>();
  }

  /** 带着 cookie 连 WebSocket（握手被拒时抛错） */
  connect(options: Omit<ConnectOptions, "cookie"> = {}): Promise<TestFrontend> {
    const cookie = this.cookieHeader;
    return TestFrontend.connect(this.baseUrl, {
      ...options,
      ...(cookie === undefined ? {} : { cookie }),
      headers: { ...(this.options.realIp === undefined ? {} : { "x-real-ip": this.options.realIp }), ...options.headers },
    });
  }
}

export interface PairDeviceOptions extends TestDeviceOptions {
  name?: string;
  /**
   * 领到凭证之后像浏览器那样重新打开页面（带着凭证问一次 /api/access），设备记录由此启用。默认是；
   * false 时停在"领到了、还没用过"（模拟领取的响应丢在半路上）
   */
  firstUse?: boolean;
}

/**
 * 走完一次配对：新设备发起请求 → 批准方（本机或已配对设备的前端，要已订阅卡片频道）批准那张配对请求卡 →
 * 新设备领到凭证（→ 第一次带着凭证来）。返回这台已配对的设备
 */
export async function pairDevice(externalUrl: string, approver: TestFrontend, options: PairDeviceOptions = {}): Promise<TestDevice> {
  const device = new TestDevice(externalUrl, { realIp: options.realIp ?? "198.51.100.7", ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }) });
  const created = await device.requestPairing(options.name);
  expect(created.status).toBe(201);
  const { id } = created.json<{ request: PairingRequestView }>().request;
  const card = await waitForPairingCard(approver, id);
  expect(await approver.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version })).toMatchObject({ ok: true });
  expect((await device.pollPairing()).status).toBe("paired");
  expect(device.credential).toBeDefined();
  if (options.firstUse ?? true) expect((await device.access()).access).toBe("device");
  return device;
}

/** 等前端收到某个配对请求的卡片 */
export async function waitForPairingCard(frontend: TestFrontend, requestId: string): Promise<Card> {
  for (;;) {
    const card = ((await frontend.next(CHANNELS.cards, EVENT_TYPES.card)).payload as CardEventPayload).card;
    if (card.type === "pairing" && (card.payload as PairingCardPayload).requestId === requestId) return card;
  }
}
