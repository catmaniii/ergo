// Windows 系统通知（右下角那种）。管理器跑在无窗口控制台里，提醒只能靠它跳出来。
// 走 WinRT 的 ToastNotificationManager，借 Windows PowerShell 的 AppID 发（不用注册自己的应用、不落任何 exe）。
// 点通知会打开 WebUI。发不出去（比如系统关了通知）只记日志，不影响别的。
import { ps } from './winproc.mjs';

const PS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

export function toastXml(title, lines, url) {
  const launch = url ? ` activationType="protocol" launch="${xmlEsc(url)}"` : '';
  return `<toast${launch}><visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text>`
    + `<text>${xmlEsc(lines.join('\n'))}</text></binding></visual></toast>`;
}

export async function toast(title, lines, { url } = {}) {
  const xml = toastXml(title, lines, url).replace(/'/g, "''");   // 放进 PowerShell 单引号字符串
  await ps([
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${xml}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${PS_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('; '), { timeout: 20000 });
}
