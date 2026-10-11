# 96 — 鸿蒙 App 里点文件附件的"下载"没反应

Status: done
Blocked by: 无（小改动，轻流程，主会话直接改）
Spec: 62 号票（鸿蒙 App 原生壳）、ADR-0022

## What to build

用户 2026-10-12：让二狗下了一个视频，作为文件发过来；浏览器里能下载，鸿蒙 App 里点下载没用。

原因：聊天里文件附件是带 `download` 的同源链接（`parts.tsx` 的 `FileView`，守护进程回 `Content-Disposition: attachment`）；ArkWeb 不设下载代理时，这种下载什么都不发生。

改法：App 壳加 `download/WebDownloads.ets`，Web 组件挂上 controller 时设 ArkWeb 的下载代理（`WebDownloadDelegate`）：先下到 App 的缓存目录，下完弹系统的"保存到"（文件名默认用附件的名字），拷过去、删掉缓存里的那份；开始、保存好、没保存、失败各弹一句提示。

## Acceptance criteria

- [x] `npm run build:harmony` 构建签名通过。
- [ ] 真机上点附件"⤓"：提示正在下载，下完弹"保存到"，选好位置后提示已保存，文件能打开（等设备连上装好后核对）。

## Comments

- 2026-10-12 主会话直接改（`download/WebDownloads.ets`、`pages/Index.ets` 加 `onControllerAttached`，`docs/dev.md` 鸿蒙 App 一节）。构建时设备都没连着，还没装到真机上验证。
