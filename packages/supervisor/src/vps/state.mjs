// `lsm vps setup` 的本机状态文件（321 号票）：数据目录里的 vps-setup.json。
//
// 记的是"在哪台 VPS 上、按哪种方式、装到了哪一步、装了什么、最后一次验收怎样"——status、remove、重跑接着做都靠它。
// VPS 上另有一份清单（/etc/ergo-vps/*.env，脚本自己写），记"装之前原来有什么"，remove 照它原样撤；两份互相印证，
// 本机这份丢了也撤得掉（remove 照 VPS 上的清单做），VPS 那份丢了本机这份还知道域名和账号。
//
// 不记任何密码、加入 tailnet 用的一次性钥匙；钥匙文件只记路径（钥匙本身在 .secrets/vps-setup/）。
import fs from 'node:fs';
import path from 'node:path';
import { VPS_STATE } from '../paths.mjs';

export const STATE_VERSION = 1;
export const MODES = ['headscale', 'tunnel'];

/**
 * modes：lsm vps setup 搭的（tunnel / headscale）；sites：lsm vps site add 加的站点（322），按站点名；
 * claimed：lsm vps scan 认领的、VPS 上原来就有的站点和证书（只记下来盯到期日，不归这里管、不撤）。
 */
export function emptyState() {
  return { version: STATE_VERSION, vps: null, modes: {}, sites: {}, claimed: null, history: [] };
}

/** 除了 except 指的那一样，这台 VPS 上还有几样东西归这份状态管（方式、站点、认领的）。为 0 时撤掉那一样就该收回管理钥匙。 */
export function othersLeft(state, { mode = null, site = null } = {}) {
  const modes = MODES.filter((m) => m !== mode && state.modes?.[m]).length;
  const sites = Object.keys(state.sites || {}).filter((n) => n !== site).length;
  const claimed = state.claimed && ((state.claimed.sites || []).length || (state.claimed.certs || []).length) ? 1 : 0;
  return modes + sites + claimed;
}

/** 读状态文件。没有 = 空；坏了报出来（不悄悄当成空的覆盖掉——里面记着装了什么，丢了就撤不干净）。 */
export function loadState(file = VPS_STATE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw new Error(`读不了 ${file}：${e.message}`, { cause: e });
  }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`${file} 不是合法的 JSON（${e.message}）——先看一眼它，别直接删：里面记着 VPS 上装了什么`, { cause: e }); }
  if (doc?.version !== STATE_VERSION) throw new Error(`${file} 的版本是 ${doc?.version}，这一版只认 ${STATE_VERSION}`);
  return { ...emptyState(), ...doc, modes: doc.modes || {}, sites: doc.sites || {}, history: doc.history || [] };
}

/** 整份写（tmp + rename）：写到一半断电也不会留下半截文件。 */
export function saveState(state, file = VPS_STATE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  renameRetry(tmp, file);
}

/**
 * Windows 上 rename 偶尔会 EPERM / EBUSY：杀毒、索引刚好开着目标文件（测试里撞到过）。等一小会儿再试，最多约 1 秒。
 */
export function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** 记一笔历史（最多留 50 条）。 */
export function remember(state, entry, now = new Date()) {
  state.history = [...(state.history || []), { at: now.toISOString(), ...entry }].slice(-50);
  return state;
}

/** 改某一种方式的记录（没有就建），返回改后的那条。 */
export function patchMode(state, mode, patch) {
  if (!MODES.includes(mode)) throw new Error(`不认识的方式：${mode}`);
  state.modes[mode] = { ...state.modes[mode], ...patch };
  return state.modes[mode];
}

/**
 * 这次要搭的 VPS 和状态文件里的是不是同一台。不是同一台就拒绝：一份状态只管一台 VPS，
 * 换机器前先 `lsm vps remove`（或换一个 --data-dir），不然旧机器上装的东西就再也没人记得了。
 */
export function sameVpsOrWhy(state, vps) {
  if (!state.vps) return null;
  if (state.vps.host === vps.host && (state.vps.port || 22) === (vps.port || 22)) return null;
  const left = [
    ...Object.keys(state.modes || {}).filter((m) => state.modes[m]),
    ...Object.keys(state.sites || {}).map((n) => `站点 ${n}`),
    ...(othersLeft({ ...state, modes: {}, sites: {} }) ? ['认领的站点和证书'] : []),
  ];
  if (!left.length) return null;
  return `状态文件里记着另一台 VPS（${state.vps.user}@${state.vps.host}，有 ${left.join('、')}）。一份状态只管一台：先 lsm vps remove / site remove 撤掉那台的，或者换一个 --data-dir`;
}
