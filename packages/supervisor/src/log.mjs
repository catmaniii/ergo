import fs from 'node:fs';
import { LOGS_DIR, MANAGER_LOG, AUDIT_LOG } from './paths.mjs';

fs.mkdirSync(LOGS_DIR, { recursive: true });

const ts = () => new Date().toISOString();

function append(file, line) {
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
