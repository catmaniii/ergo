// 开机自启列表：管理器在**新的登录会话**里起来后，自动拉起哪些服务——开机自启是一张你勾选的名单，不是 autoRestart 的副作用。
//
// 列表由 WebUI 卡片上的「开机自启」开关维护，也可以手改 registry/autostart.yaml。
// 它是配置（你的选择），所以放在 registry/ 下；不放进 state.json——那是易失的运行状态。
import fs from 'node:fs';
import YAML from 'yaml';
import { BOOT_FILE } from './paths.mjs';

const HEADER = [
  '# 开机自启：管理器在新的登录会话里（开机、注销后重新登录）起来后，自动拉起这些服务。',
  '# 不在这里的服务开机后一律不拉——哪怕关机前它在跑、哪怕它开着 autoRestart。',
  '# 管理器自己重启（看门狗、改代码）不算开机，不会按这个列表重新拉一遍。',
  '#',
  '# 平时用 WebUI 卡片上的「开机自启」开关改；手改也行，改完 lsm reload。',
  '# 这个文件由管理器整份重写，写在这里的注释会被覆盖。',
];

/** 读列表。文件不存在 = 空列表；解析失败要报出来，而不是当成空列表悄悄覆盖掉你手改的内容。 */
export function loadBootList(file = BOOT_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch (e) {
    if (e.code === 'ENOENT') return { ids: new Set(), error: null };
    return { ids: new Set(), error: `autostart.yaml 读不了：${e.message}` };
  }
  try {
    const doc = YAML.parse(raw) || {};
    if (doc.services != null && !Array.isArray(doc.services)) return { ids: new Set(), error: 'autostart.yaml: services 必须是列表' };
    return { ids: new Set((doc.services || []).filter((x) => typeof x === 'string' && x)), error: null };
  } catch (e) {
    return { ids: new Set(), error: `autostart.yaml 解析失败：${e.message}` };
  }
}

export function saveBootList(ids, file = BOOT_FILE) {
  const list = [...ids].sort();
  const body = [...HEADER, list.length ? 'services:' : 'services: []', ...list.map((id) => `  - ${id}`), ''].join('\n');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);   // 原子替换，避免半截文件
}

/** 这个服务能不能放进开机自启；不能的话为什么。界面上的开关和 API 都从这里取。 */
export function autostartBlocked(svc) {
  if (svc.kind === 'external') return `${svc.id} 是外部服务，管理器只探活不负责生死`;
  if (!svc.capabilities?.includes('start')) return `${svc.id} 没有 start 能力`;
  return null;
}

/**
 * 这次启动要不要按开机处理。
 *
 * 判据是「登录会话的建立时间」（本会话里最早那个进程——csrss——的启动时间）：
 * 开机、注销再登录都会变；管理器自己重启（看门狗、Stop/Start-ScheduledTask、改代码）不会变。
 * 不用开机时间（os.uptime）：Win11 默认开着快速启动，「关机」其实是休眠内核，
 * 开机时间根本不变，而你的会话早已注销、所有服务都死了。
 *
 * 读不到（null）或第一次记录时一律按「不是新会话」处理：
 * 宁可这一次不自启，也不能把一次普通的管理器重启当成开机、把你手动起的服务全清掉。
 */
export function bootPlan({ prevEpoch, epoch, bootList, services }) {
  const fresh = !!(prevEpoch && epoch && prevEpoch !== epoch);
  if (!fresh) return { fresh: false, start: [] };
  const start = [...bootList].filter((id) => {
    const svc = services.get(id);
    return svc && !autostartBlocked(svc);
  });
  return { fresh: true, start };
}
