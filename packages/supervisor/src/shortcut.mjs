// 桌面快捷方式 + 可选的「登录后自动打开前端」。
//
// 曾经用 .vbs 静默壳（Run(...,0,False) 零闪窗），但 2026-08-23 实测被 360 安全卫士锁住：
// 文件在、大小对，读它直接 Access denied——杀软对 .vbs 一向敏感，这条路不能走。
// 换成 .url 互联网快捷方式：纯文本、无脚本、零闪窗、杀软不管，浏览器直接打开。
// 代价是它不会「管理器没起就先拉起来」——但管理器本来就是登录自启的，正常情况它一直在。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';
import { ps, psJson } from './winproc.mjs';

export const OPEN_TASK = 'LocalServiceManager-OpenWebUI';
const PS1 = path.join(ROOT, 'deploy', 'open-webui.ps1');

function q(s) { return String(s).replace(/'/g, "''"); }

async function desktop() {
  const rows = await psJson(`@{ p = [Environment]::GetFolderPath('Desktop') }`);
  return rows[0]?.p || path.join(process.env.USERPROFILE || '', 'Desktop');
}

export async function installShortcut(name = '本地服务管理器', url = null) {
  const dir = await desktop();
  const target = path.join(dir, `${name}.url`);
  const addr = url || `http://127.0.0.1:7420/`;
  // .url 是 INI 格式，必须 CRLF；IconFile 给个地球图标，一眼看出是网页入口
  fs.writeFileSync(target, [
    '[InternetShortcut]',
    `URL=${addr}`,
    'IconFile=C:\\Windows\\System32\\shell32.dll',
    'IconIndex=14',
    '',
  ].join('\r\n'), 'utf-8');

  // 清掉上一版留下的 .lnk（它指向被杀软锁死的 vbs，双击会报 Invalid character）
  const legacy = path.join(dir, `${name}.lnk`);
  try { if (fs.existsSync(legacy)) fs.unlinkSync(legacy); } catch {}

  return { ok: true, file: target, url: addr };
}

/** 可选：登录后自动打开前端。默认不装——每次开机弹个浏览器标签页是会让人后悔的那种功能。 */
export async function installAutoOpen(delaySeconds = 25) {
  await ps([
    // 这里可以放心用 powershell：它是计划任务在后台跑，不经过杀软敏感的 .vbs
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${q(PS1)}"'`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$trigger.Delay = 'PT${delaySeconds}S'`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
    `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName '${OPEN_TASK}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '登录后自动打开本地服务管理器前端' -Force | Out-Null`,
  ].join('; '));
  return { ok: true, task: OPEN_TASK };
}

export async function uninstallAutoOpen() {
  await ps(`Unregister-ScheduledTask -TaskName '${OPEN_TASK}' -Confirm:$false`);
  return { ok: true };
}
