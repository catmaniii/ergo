// 日志切分：单个日志超过上限就切开——现在这份改名成 <文件>.1，旧的往后挪（.1 → .2 …），只留最近几份，新的从头写。
//
// 管理器写的两类日志：
//  - 它自己的 manager.log、audit.log：每次追加都是管理器自己开、写、关，随时能切（log.mjs 在追加前看一眼）。
//  - 服务的命令行输出 logs/<id>.out.log：不是管理器转写的，是服务外面那层 cmd 自己 `>> 日志 2>&1` 打开、
//    交给服务进程直接写的（为什么这样见 hooks.mjs 的 spawnDetached）。cmd 打开时只许别人读：
//    服务在跑的时候，改名、截断、追加一律 EBUSY（2026-11-07 实测），所以「复制后截断」也做不到。
//    这种文件只能等它没人占着时切：服务下一次启动前（spawnDetached / runHook 打开它之前）、或者巡检时发现它已经没人占着。
//
// 每个阈值的默认值只在这里定一次；manager.yaml 的 logs.maxMB / logs.keep 能改。
import fs from 'node:fs';

/** 单个日志超过多少 MB 就切 */
export const DEFAULT_MAX_MB = 20;
/** 切下来的旧日志留几份（<文件>.1 是最近的一份） */
export const DEFAULT_KEEP = 3;
/** 留的份数最多能写多少：份数是拿来兜磁盘的，不是拿来存档的 */
export const MAX_KEEP = 50;

export const DEFAULT_ROTATION = Object.freeze({ maxBytes: DEFAULT_MAX_MB * 1024 * 1024, keep: DEFAULT_KEEP });

/**
 * manager.yaml 的 `logs:` → 切分规则。写错的那一项报错并用默认值（宁可报出来，也不悄悄改成一个你没写过的值）。
 *   logs:
 *     maxMB: 20    单个日志的上限（MB，可以写小数）；0 = 不切
 *     keep: 3      切下来的旧日志留几份
 */
export function rotationPolicy(raw) {
  const errors = [];
  if (raw == null) return { policy: { ...DEFAULT_ROTATION }, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { policy: { ...DEFAULT_ROTATION }, errors: [`manager.yaml: logs 要写成 maxMB / keep 两项，得到 ${JSON.stringify(raw)}；先按默认（${DEFAULT_MAX_MB} MB、留 ${DEFAULT_KEEP} 份）`] };
  }
  let maxMB = DEFAULT_MAX_MB;
  if (raw.maxMB != null) {
    if (typeof raw.maxMB === 'number' && Number.isFinite(raw.maxMB) && raw.maxMB >= 0) maxMB = raw.maxMB;
    else errors.push(`manager.yaml: logs.maxMB 要是不小于 0 的数（0 = 不切），得到 ${JSON.stringify(raw.maxMB)}；先按默认 ${DEFAULT_MAX_MB} MB`);
  }
  let keep = DEFAULT_KEEP;
  if (raw.keep != null) {
    if (Number.isInteger(raw.keep) && raw.keep >= 1 && raw.keep <= MAX_KEEP) keep = raw.keep;
    else errors.push(`manager.yaml: logs.keep 要是 1 到 ${MAX_KEEP} 的整数，得到 ${JSON.stringify(raw.keep)}；先按默认 ${DEFAULT_KEEP} 份`);
  }
  return { policy: { maxBytes: Math.round(maxMB * 1024 * 1024), keep }, errors };
}

/** 切下来的第 n 份（1 = 最近的一份） */
export const rotatedFile = (file, n) => `${file}.${n}`;

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * 超过上限就切。返回：
 *  - { rotated: true, size }              切了：原来那份现在是 <文件>.1
 *  - { rotated: false, busy: true, size } 超了，但文件正被别人占着写（服务的 cmd 开着它），这次切不了
 *  - { rotated: false, size? }            没超、不存在、或者不切（maxBytes 是 0）
 *  - { rotated: false, why }              切到一半出错（已尽量复原）
 *
 * 先把现在这份挪到一个临时名字上：挪得动才说明没人占着，这时才去动 .1 .2 …；
 * 挪不动就什么都不碰——不然每次巡检都把旧的往后挤一格，最老的白白被删掉。
 * 上一次切到一半（进程恰好死在两次改名之间）留下的临时文件会被这次覆盖。
 */
export function rotateIfLarge(file, { maxBytes, keep } = DEFAULT_ROTATION) {
  if (!(maxBytes > 0)) return { rotated: false };
  let size;
  try { size = fs.statSync(file).size; } catch { return { rotated: false }; }
  if (size <= maxBytes) return { rotated: false, size };

  const tmp = `${file}.rotating`;
  try { fs.renameSync(file, tmp); } catch (e) {
    if (BUSY.has(e.code)) return { rotated: false, busy: true, size };
    return { rotated: false, size, why: `${e.code || ''} ${e.message}`.trim() };
  }
  // 份数调小过的话，比 keep 更老的也一起清掉
  for (let n = keep; fs.existsSync(rotatedFile(file, n)); n++) {
    try { fs.rmSync(rotatedFile(file, n), { force: true }); } catch {}
  }
  for (let n = keep - 1; n >= 1; n--) {
    const from = rotatedFile(file, n);
    if (!fs.existsSync(from)) continue;
    try { fs.renameSync(from, rotatedFile(file, n + 1)); } catch {}
  }
  try {
    fs.renameSync(tmp, rotatedFile(file, 1));
  } catch (e) {
    // 极少见（.1 正被别人以不许删的方式开着）：把现在这份挪回去，下次再切
    try { if (!fs.existsSync(file)) fs.renameSync(tmp, file); } catch {}
    return { rotated: false, size, why: `${e.code || ''} ${e.message}`.trim() };
  }
  return { rotated: true, size };
}
