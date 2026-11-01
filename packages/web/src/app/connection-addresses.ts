// 连接地址（364 号票）在网页上的这一半里"不碰浏览器"的那部分：取（GET /api/connection-addresses）、改手填的那个（POST）、演示页的假数据、
// 地址旁边写什么。种类、校验、排序在共享协议包的 connection-addresses.ts；真相在守护进程（入口问服务管家，手填的在配置文件）。
// 这些函数都不碰 window、不引 React（Node 里直接查，test/pages/pairing-qr.test.ts）：钩子在 app/page-connection-addresses.ts。
import { checkManualConnectionAddress, type ConnectionAddress, type ConnectionAddressesView, HTTP_PATHS, type HttpErrorBody, orderConnectionAddresses, t } from "../state/index.ts";

async function readView(res: Response): Promise<ConnectionAddressesView> {
  if (!res.ok) {
    const error = (await res.json().catch(() => undefined)) as HttpErrorBody | undefined;
    throw new Error(error?.message ?? t("pages.devices.qr.loadFailed", { reason: String(res.status) }));
  }
  return (await res.json()) as ConnectionAddressesView;
}

/** 现在的地址（每次现取） */
export async function fetchConnectionAddresses(): Promise<ConnectionAddressesView> {
  return readView(await fetch(HTTP_PATHS.connectionAddresses, { credentials: "same-origin" }));
}

/** 改手填的那个（null 是去掉）；写法不对、是局域网地址时抛错，message 是守护进程的原话 */
export async function postManualAddress(manual: string | null): Promise<ConnectionAddressesView> {
  const res = await fetch(HTTP_PATHS.connectionAddresses, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manual }),
  });
  return readView(res);
}

/** 填的地址能不能存：能存是 undefined，不能存是给人看的原因（守护进程还会再查一遍，这里只为了不白发一次请求） */
export function manualAddressProblem(input: string): string | undefined {
  const checked = checkManualConnectionAddress(input);
  return checked.ok ? undefined : t(`pairing.address.invalid.${checked.problem}`);
}

/** 地址的种类怎么叫 */
export function addressKindLabel(address: ConnectionAddress): string {
  return t(`pages.devices.qr.kind.${address.kind}`);
}

/** 地址旁边的小字：打没打通（手填的管理器不测，不写"没测过"：用户自己填的，手机扫的时候会真的测）；tailnet 写明手机要先连上 */
export function addressNotes(address: ConnectionAddress): string[] {
  const notes: string[] = [];
  if (address.reachable === true) notes.push(t("pages.devices.qr.state.reachable"));
  else if (address.reachable === false) notes.push(t("pages.devices.qr.state.unreachable"));
  else if (address.kind !== "manual") notes.push(t("pages.devices.qr.state.untested"));
  if (address.kind === "tailnet") notes.push(t("pages.devices.qr.tailnetNote"));
  return notes;
}

/** 演示页（没有守护进程）的假数据：公网打通了、tailnet 没测过 */
export function demoConnectionAddressesView(manual?: string): ConnectionAddressesView {
  const addresses: ConnectionAddress[] = [
    { kind: "public", url: "https://ergo.example.com/", reachable: true },
    { kind: "tailnet", url: "https://ergo.tail.example.com/", reachable: null },
    ...(manual === undefined ? [] : [{ kind: "manual" as const, url: manual, reachable: null }]),
  ];
  return { addresses: orderConnectionAddresses(addresses), ...(manual === undefined ? {} : { manual }), manager: "supported", managerUrl: "http://127.0.0.1:7420/", rejected: [] };
}
