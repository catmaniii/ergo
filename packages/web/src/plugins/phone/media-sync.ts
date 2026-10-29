// 照片的时间地点、位置同步一次（300 号票）：在鸿蒙 App 里，网页经原生桥读相册里照片的时间地点、手机上记下的位置点，交给守护进程
// （"手机 · 照片的时间地点""手机 · 位置"两个数据源）。纯逻辑，测试换假的原生桥和 HTTP。同手机日历（calendar-sync.ts）两种：
// - 连上（link）：用户在数据源页点了"连上相册""开始记位置"——先要授权（系统的授权框；拒过的拉起二次授权），给了就读、交过去
//   （带 link，守护进程记下连着了）；位置还要先让 App 开始记（带不带"后台也记"），App 开始记时先定一次位，有一个点就交过去；
// - 平常（App 开着时每 30 分钟、回到前台、点"现在同步"）：先问守护进程连没连着（没连着、插件没启用、导入关着都不做；位置这时
//   App 还在记的让它停下、手机上没交出去的点删掉——断开了、关掉了就不该再记）；授权给着就读、交；被撤回了交一次状况和原因
//   （守护进程那边已经写着出错的不再交）。
// 照片读哪段时间：最近 7 天拍的，上次同步更早时往前读到上次同步的前一天（最多 30 天，phonePhotosWindow）；读重了守护进程只收一次。
// 位置交的是手机上记下、还没交出去的点；守护进程收下以后让 App 删掉交过的（ack），交失败的下次再交。
// 系统的位置开关关着（记不到）：平常同步时手机上没有要交的点，就交一次状况和原因（"读不了"，守护进程那边写着出错的不再交）；开关打开后照常交，守护进程那边回到连着。
import type { NativeLocationState, NativePhoneLocation, NativePhonePhotos } from "../../app/native-phone.ts";
import {
  type DataSourcePushResult,
  type DataSourcesView,
  type DataSourceView,
  nowIso,
  PHONE_LOCATION_SOURCE,
  PHONE_PHOTOS_SOURCE,
  type PhoneLocationPush,
  type PhonePhotosPush,
  phonePhotosWindow,
  t,
} from "../../state/index.ts";

export interface PhoneMediaSyncDeps {
  http: { dataSources(): Promise<DataSourcesView>; dataSourcePush(id: string, body: { data: PhonePhotosPush | PhoneLocationPush; idempotencyKey: string }): Promise<DataSourcePushResult> };
  now: () => Date;
  newKey: () => string;
}

/** 同步一次的结果：没做（为什么）、没给授权、读不了、交过去了（守护进程回的） */
export type PhoneMediaSyncOutcome =
  | { kind: "skipped"; why: "not_linked" | "plugin_off" | "import_off" | "already_reported" }
  | { kind: "denied" }
  | { kind: "unreadable"; message?: string }
  | { kind: "pushed"; result: DataSourcePushResult; state: "granted" | "denied" | "revoked" | "unavailable" };

type Skip = Extract<PhoneMediaSyncOutcome, { kind: "skipped" }>;

/** 平常同步前问守护进程：插件没启用、没连着、导入关着的不做；连着但写着出错的（已经交过状况）记下 */
async function check(http: PhoneMediaSyncDeps["http"], id: string): Promise<{ skip: Skip } | { source: DataSourceView; reported: boolean }> {
  const source = (await http.dataSources()).sources.find((s) => s.id === id);
  if (!source || !source.available) return { skip: { kind: "skipped", why: "plugin_off" } };
  if (source.connection === "not_connected") return { skip: { kind: "skipped", why: "not_linked" } };
  if (!source.usages.some((u) => u.usage === "import" && u.on)) return { skip: { kind: "skipped", why: "import_off" } };
  return { source, reported: source.connection === "error" };
}

const pushTo = async (deps: PhoneMediaSyncDeps, id: string, data: PhonePhotosPush | PhoneLocationPush): Promise<PhoneMediaSyncOutcome> => ({
  kind: "pushed",
  state: data.state,
  result: await deps.http.dataSourcePush(id, { data, idempotencyKey: deps.newKey() }),
});

/** 照片的时间地点同步一次；link 为真是用户点了"连上相册"。守护进程拒收、网络出错时抛错（message 是原因） */
export async function syncPhonePhotos(deps: PhoneMediaSyncDeps & { photos: NativePhonePhotos }, options: { link?: boolean } = {}): Promise<PhoneMediaSyncOutcome> {
  const { photos } = deps;
  const link = options.link === true;
  let reported = false;
  let lastSyncAt: string | undefined;
  if (!link) {
    const checked = await check(deps.http, PHONE_PHOTOS_SOURCE);
    if ("skip" in checked) return checked.skip;
    reported = checked.reported;
    const last = checked.source.lastSync;
    lastSyncAt = last && last.error === undefined ? last.at : undefined;
  }
  let state = photos.state();
  if (link && state?.granted !== true) state = await photos.prepare(true);
  const device = state?.device === undefined ? {} : { device: state.device };
  if (state?.granted !== true) {
    if (link) return { kind: "denied" };
    if (reported) return { kind: "skipped", why: "already_reported" };
    return pushTo(deps, PHONE_PHOTOS_SOURCE, { ...device, state: "revoked", reason: t("ui.plugins.phone.photos.revokedReason") });
  }
  const window = phonePhotosWindow(deps.now(), lastSyncAt);
  const read = await photos.read(window.from, window.to);
  if (!read.ok) {
    if (link) return read.state === "denied" ? { kind: "denied" } : { kind: "unreadable", ...(read.message === undefined ? {} : { message: read.message }) };
    if (reported) return { kind: "skipped", why: "already_reported" };
    return pushTo(deps, PHONE_PHOTOS_SOURCE, { ...device, state: read.state === "denied" ? "revoked" : "unavailable", ...(read.message === undefined ? {} : { reason: read.message }) });
  }
  return pushTo(deps, PHONE_PHOTOS_SOURCE, { ...device, state: "granted", ...(link ? { link: true } : {}), location: read.location, from: nowIso(window.from), to: nowIso(window.to), photos: read.photos });
}

/**
 * 位置同步一次；link 为真是用户点了"开始记位置"，background 给了是用户刚改了"后台也记"（不给照 App 现在的）。
 * 守护进程拒收、网络出错时抛错（message 是原因）
 */
export async function syncPhoneLocation(deps: PhoneMediaSyncDeps & { location: NativePhoneLocation }, options: { link?: boolean; background?: boolean } = {}): Promise<PhoneMediaSyncOutcome> {
  const { location } = deps;
  const link = options.link === true;
  let reported = false;
  if (!link) {
    const checked = await check(deps.http, PHONE_LOCATION_SOURCE);
    if ("skip" in checked) {
      // 断开了、导入关了：App 还在记的停下（手机上没交出去的点一起删）
      if ((checked.skip.why === "not_linked" || checked.skip.why === "import_off") && location.state()?.recording === true) await location.record(false, false);
      return checked.skip;
    }
    reported = checked.reported;
  }
  let state: NativeLocationState | undefined = location.state();
  if (link && state?.granted !== true) state = await location.prepare(true);
  const device = state?.device === undefined ? {} : { device: state.device };
  if (state?.granted !== true) {
    if (link) return { kind: "denied" };
    if (reported) return { kind: "skipped", why: "already_reported" };
    return pushTo(deps, PHONE_LOCATION_SOURCE, { ...device, state: "revoked", reason: t("ui.plugins.phone.location.revokedReason") });
  }
  const background = options.background ?? state.background;
  // 刚连上、App 没在记（重装了、被系统停了）、改了"后台也记"：让 App 开始记
  if (link || !state.recording || background !== state.background) state = (await location.record(true, background)) ?? state;
  const read = await location.read();
  if (!read.ok) {
    if (link) return read.state === "denied" ? { kind: "denied" } : { kind: "unreadable", ...(read.message === undefined ? {} : { message: read.message }) };
    if (reported) return { kind: "skipped", why: "already_reported" };
    return pushTo(deps, PHONE_LOCATION_SOURCE, { ...device, state: read.state === "denied" ? "revoked" : "unavailable", ...(read.message === undefined ? {} : { reason: read.message }) });
  }
  if (!link && state.switchOff === true && read.points.length === 0) {
    if (reported) return { kind: "skipped", why: "already_reported" };
    return pushTo(deps, PHONE_LOCATION_SOURCE, { ...device, state: "unavailable", reason: t("ui.plugins.phone.location.switchOffReason") });
  }
  const outcome = await pushTo(deps, PHONE_LOCATION_SOURCE, { ...device, state: "granted", ...(link ? { link: true } : {}), background, points: read.points });
  // 收下了才让 App 删掉交过的；没收下的下次再交
  const last = read.points.at(-1);
  if (outcome.kind === "pushed" && outcome.result.error === undefined && last) location.ack(new Date(last.at));
  return outcome;
}
