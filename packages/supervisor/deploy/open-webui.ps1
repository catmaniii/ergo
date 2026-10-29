# 打开服务管理器前端。
# 比一个裸 URL 快捷方式多做三件事：管理器没起就先把它拉起来、等它真的能应答、再开浏览器——
# 否则开机后手快点一下只会看到 ERR_CONNECTION_REFUSED。
#
# 用法：`lsm auto-open` 注册的登录后计划任务调它（无窗口）；也可以手动 powershell -File 跑。
# （以前有个 .vbs 静默壳，被杀软锁死后弃用了，见 src/shortcut.mjs）
# NOTE: keep this file ASCII-only where possible; it is saved as UTF-8 with BOM.
param(
    [string]$Url = "http://127.0.0.1:7420/",
    [string]$TaskName = "LocalServiceManager",
    [int]$WaitSeconds = 40
)
$ErrorActionPreference = "SilentlyContinue"

function Test-Manager {
    try {
        $r = Invoke-WebRequest -Uri ($Url + "api/auth/status") -TimeoutSec 2 -UseBasicParsing
        return $r.StatusCode -lt 500
    } catch { return $false }
}

if (-not (Test-Manager)) {
    # 管理器不在：先请计划任务把它拉起来（它就是本机唯一的自启入口）
    Start-ScheduledTask -TaskName $TaskName
    for ($i = 0; $i -lt $WaitSeconds; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Manager) { break }
    }
}

Start-Process $Url
