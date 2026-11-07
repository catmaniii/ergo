import fs from 'node:fs';
import { LOGS_DIR, MANAGER_LOG, AUDIT_LOG } from './paths.mjs';
import { DEFAULT_ROTATION, rotateIfLarge } from './rotate.mjs';

fs.mkdirSync(LOGS_DIR, { recursive: true });

const ts = () => new Date().toISOString();

// manager.log、audit.log 也按 manager.yaml 的 logs: 切（rotate.mjs）。Supervisor 读完 manager.yaml 后告诉这里；
// 在那之前（或者只 import 了这个模块的地方）按默认。
let rotation = DEFAULT_ROTATION;
export function setLogRotation(policy) { rotation = policy || DEFAULT_ROTATION; }

function append(file, line) {
  // 这两份是管理器自己每次开、写、关的，随时能切；另一个 lsm 进程（CLI 本地直连）同时在写也只是开着它一瞬间
  try { rotateIfLarge(file, rotation); } catch {}
  try { fs.appendFileSync(file, line + '\n', 'utf-8'); } catch {}
}

export function log(level, msg, extra) {
  const line = `${ts()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  append(MANAGER_LOG, line);
  if (process.env.LSM_QUIET !== '1') console.log(line);
}

export const info = (m, e) => log('info', m, e);
export const warn = (m, e) => log('warn', m, e);
export const error = (m, e) => log('error', m, e);

/** 所有写操作留痕——WebUI 要出网，没有审计不能上。 */
export function audit(action, detail) {
  append(AUDIT_LOG, JSON.stringify({ ts: ts(), action, ...detail }));
}
