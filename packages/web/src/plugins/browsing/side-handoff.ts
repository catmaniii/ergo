// 浏览侧边栏里点了二狗自己的页面（447："侧边栏里地图卡片能点开到地图页"）：侧边栏是 App 另开的一个 Web 组件（?ergo=side，SideApp），
// 整页只画侧边栏、不认地址里的 #——卡片上的"看大地图"（#/more/map/card/<编号>）、别的卡片里的 #/… 链接在这里点了什么都不发生。
// 要交给"浏览"页那一份（主页面）去打开，走现有的两条路，App 不用改：
// - 侧边栏这一页把要去的地址记进本机存储（SIDE_GOTO_KEY，带时刻；同一个 App 里两个 Web 组件同一个来源、共用 localStorage），
//   再调 App 给的"收起"（window.ergoSide.close()）——App 原样转给主页面（NativeBrowserEvent 的 side close）；
// - 主页面收到"收起"时取出这一条（SIDE_GOTO_FRESH_MS 以内写的才算），跳过去（离开"浏览"时原生浏览器、侧边栏照旧藏起来）；
//   存储的 storage 事件先到的话先跳（收起后来时已经取走了，不再跳）。写和取都只认 #/ 开头的二狗地址，取走就删。
// 收起是故意的：窄屏侧边栏整屏盖着，不收起看不到主页面；宽屏回到"浏览"时侧边栏是收着的，再点二狗按钮打开。
// 不碰浏览器的全局变量（存储、时钟由参数给），测试在 Node 里跑；接到页面上的在 page-side.ts（侧边栏这一页）和 page-browse.ts（主页面）。

/** 存在本机存储的哪个键 */
export const SIDE_GOTO_KEY = "ergo-side-goto";
/** 写下后多久以内算数（毫秒）：收起转到主页面要经 App 走一趟，留足；过了的当没有（上次没取走的残留） */
export const SIDE_GOTO_FRESH_MS = 8000;
/** 地址最长多少（卡片编号、日期这些，远用不到） */
const HASH_MAX = 300;

/** 用到的那一点 localStorage */
export interface SideGotoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 是不是二狗自己的页面地址（#/ 开头、不太长、没有空白） */
export function isAppHash(hash: string): boolean {
  return hash.startsWith("#/") && hash.length > 2 && hash.length <= HASH_MAX && !/\s/.test(hash);
}

/** 侧边栏这一页：记下要主页面去的地址；不是二狗的地址、存不了交回 false */
export function writeSideGoto(storage: SideGotoStorage, hash: string, now: number): boolean {
  if (!isAppHash(hash)) return false;
  try {
    storage.setItem(SIDE_GOTO_KEY, JSON.stringify({ hash, at: now }));
    return true;
  } catch {
    return false;
  }
}

/** 主页面：取出侧边栏记下的地址（取了就删）；没有、过了时、写法不对是 undefined */
export function takeSideGoto(storage: SideGotoStorage, now: number): string | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(SIDE_GOTO_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    storage.removeItem(SIDE_GOTO_KEY);
  } catch {
    // 删不掉：照样只认时刻，过一会儿就不算了
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return undefined;
    const { hash, at } = v as Record<string, unknown>;
    if (typeof hash !== "string" || typeof at !== "number" || !isAppHash(hash)) return undefined;
    return now - at >= 0 && now - at <= SIDE_GOTO_FRESH_MS ? hash : undefined;
  } catch {
    return undefined;
  }
}

/** 点到的是不是要交给主页面的链接：<a href="#/…">、左键、没按 Ctrl / ⌘ / Shift / Alt、没被别人拦下；是的交回地址 */
export function sideLinkHash(click: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }, href: string | null): string | undefined {
  if (click.defaultPrevented || click.button !== 0 || click.ctrlKey || click.metaKey || click.shiftKey || click.altKey) return undefined;
  return href !== null && isAppHash(href) ? href : undefined;
}
