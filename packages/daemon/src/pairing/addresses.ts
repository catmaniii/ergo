// 连接地址：手机从外面连到这台二狗用的地址。网关两个端口都只听 127.0.0.1，二狗自己不知道外面怎么连到它，
// 所以问服务管家（link 协议 §8：公网隧道、tailnet 入口，最近一次从外面打通了没有），服务管家不知道的（自己搭的反代、frp）用户手填一个。
// - 只读：不开隧道、不开入口。二维码里只放地址，配对规则不变（电脑上照常批准）；
// - 只算接到外网端口的入口：外网端口每个请求都要设备凭证，本机端口对本机请求自动信任，接到外面就是把门开着。管理器筛过一遍（wrongPort），
//   这里再按 port 核对一遍（老版本、写错了的管理器都不能把本机端口的入口塞给手机）。用不了的写进日志和体检；
// - 老管理器、没接入：不报错，只有手填的那个；
// - 真相：入口在服务管家，手填的在配置文件（config/ergo.json 的 connection.manualAddress）。
import { checkAppAddress, checkManualConnectionAddress, type ConnectionAddress, type ConnectionAddressesView, orderConnectionAddresses, type RejectedConnectionAddress, t } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { DISABLED_LSM_ENTRIES, type LsmEntries, type LsmEntry } from "../lsm/link.ts";

export interface ConnectionAddressesOptions {
  /** 配置文件里手填的那个（读配置时收拾过的） */
  manual: string | undefined;
  /** 手填的改了：写进配置文件；写不了抛错 */
  save(manual: string | undefined): void;
  log(line: string): void;
}

/** 组合根在接入层建好之后接上（网关先起来，外网端口要等网关监听了才知道） */
export interface ConnectionAddressesLink {
  entries: LsmEntries;
  managerUrl: string | undefined;
  externalPort: number;
}

export interface ConnectionAddressesService {
  /** 现在的地址（每次现算，不碰网络） */
  view(): ConnectionAddressesView;
  /** 改手填的那个（null 是去掉）；写法不对、是局域网地址时抛 RequestRejected，message 给人看 */
  setManual(input: string | null): ConnectionAddressesView;
  /** 接上接入层；返回断开（守护进程停的时候） */
  attach(link: ConnectionAddressesLink): () => void;
}

export function createConnectionAddresses(options: ConnectionAddressesOptions): ConnectionAddressesService {
  let manual = options.manual;
  let link: ConnectionAddressesLink = { entries: DISABLED_LSM_ENTRIES, managerUrl: undefined, externalPort: 0 };
  let rejectedLogged = "";

  /** 服务管家给的入口拆成能用的和用不了的 */
  const split = (): { usable: ConnectionAddress[]; rejected: RejectedConnectionAddress[] } => {
    const current = link.entries.current;
    const usable: ConnectionAddress[] = [];
    const rejected: RejectedConnectionAddress[] = [];
    const wrong = (e: LsmEntry) => rejected.push({ kind: e.kind, url: e.url, reason: "wrong_port", port: e.port });
    for (const e of current?.entries ?? []) {
      if (e.port !== link.externalPort) {
        wrong(e);
        continue;
      }
      const checked = checkAppAddress(e.url);
      if (checked.ok) usable.push({ kind: e.kind, url: checked.url, reachable: e.reachable });
      else rejected.push({ kind: e.kind, url: e.url, reason: "not_https", port: e.port });
    }
    for (const e of current?.wrongPort ?? []) wrong(e);
    return { usable, rejected };
  };

  /** 用不了的入口只在变了时记一条：探活每轮都可能问到这里 */
  const logRejected = (rejected: readonly RejectedConnectionAddress[]) => {
    // @i18n-ignore-next log：只进日志
    const text = rejected.map((r) => `${r.url}（${r.reason === "wrong_port" ? `接到了端口 ${r.port ?? "不明"}，外网端口是 ${link.externalPort}` : "不是 https"}）`).join("、");
    if (text === rejectedLogged) return;
    rejectedLogged = text;
    if (text.length > 0) options.log(`服务管家给的入口手机用不了，不放进二维码：${text}`);
  };

  const report = () => logRejected(split().rejected);

  const view = (): ConnectionAddressesView => {
    const { usable, rejected } = split();
    const addresses = orderConnectionAddresses([...usable, ...(manual === undefined ? [] : [{ kind: "manual" as const, url: manual, reachable: null }])]);
    return {
      addresses,
      ...(manual === undefined ? {} : { manual }),
      manager: link.entries.support,
      ...(link.managerUrl === undefined ? {} : { managerUrl: link.managerUrl }),
      rejected,
    };
  };

  return {
    view,
    setManual(input) {
      if (input === null || input.trim().length === 0) {
        if (manual !== undefined) options.save(undefined);
        manual = undefined;
        return view();
      }
      const checked = checkManualConnectionAddress(input);
      if (!checked.ok) throw new RequestRejected("bad_params", t(`protocol.connectionAddress.invalid.${checked.problem}`));
      if (checked.url !== manual) options.save(checked.url);
      manual = checked.url;
      return view();
    },
    attach(next) {
      link = next;
      report();
      const off = next.entries.onChange(report);
      return () => {
        off();
        link = { entries: DISABLED_LSM_ENTRIES, managerUrl: undefined, externalPort: 0 };
      };
    },
  };
}
