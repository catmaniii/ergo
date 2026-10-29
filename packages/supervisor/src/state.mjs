// 运行状态：易失数据，与注册表物理分开存——手改配置不会误伤状态。
import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILE } from './paths.mjs';

const EMPTY = { version: 1, manager: {}, services: {} };

/**
 * 只该活在内存里、绝不能跨重启带过来的键。
 *
 * 由来（2026-09-03）：autoRestart 的防重入闸曾经写在 st 上，于是被 persist() 落了盘；
 * 管理器在退避中途死掉，`finally` 没跑到，重启后读回 `autoRestarting: true`，
 * 六条隧道的自动重启**永久失效**——公网全线 502，日志里一声不吭。
 *
 * 闸已经挪到 Supervisor 实例上了，这里是第二道防线：**「正在做某事」这类标志一旦落盘，
 * 就等于把一个必然会中断的动作记成了永久事实。** 谁再往 st 上挂这种键，在这里被剥掉。
 */
export const TRANSIENT_KEYS = ['autoRestarting'];

/** 就地剥掉易失标志。单独导出是为了能直接测——这条规则值得有回归测试守着。 */
export function stripTransient(services) {
  for (const st of Object.values(services || {})) {
    for (const k of TRANSIENT_KEYS) delete st[k];
  }
  return services;
}

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return { ...EMPTY, ...raw, services: stripTransient(raw.services || {}) };
  } catch { return structuredClone(EMPTY); }
}

export function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, STATE_FILE);   // 原子替换，避免半截文件
}

export function serviceState(state, id) {
  if (!state.services[id]) {
    state.services[id] = { state: 'STOPPED', pid: null, pidStart: null, port: null, tier: null };
  }
  return state.services[id];
}
