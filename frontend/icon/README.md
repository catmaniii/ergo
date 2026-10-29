# 二狗的 App 图标

定稿：戴耳麦的小狗，头后一圈蓝紫粉的 AI 唤醒光环和一颗 ✦（用户 2026-10-09 定）。半写实半卡通的暖橙色小狗，奶油色底。

- `foreground-master.png`：前景原图（1254×1254，透明背景），用 ChatGPT 生成。
- `generate.mjs`：从原图生成各平台的图标资源，在仓库根目录跑 `node frontend/icon/generate.mjs`（给一个目录参数会另出三张预览图）。背景层不用原图，是脚本里画的奶油色径向渐变。

生成的东西：

| 平台 | 文件 | 说明 |
|---|---|---|
| 鸿蒙 | `harmony/AppScope/…/media/`、`harmony/entry/…/media/` 的 `foreground.png`、`background.png` | 分层图标，1024×1024，主体高占 74% |
| 鸿蒙 | `harmony/entry/…/media/startIcon.png` | 启动页图标，288×288 圆角方形 |
| 安卓 | `android/app/src/main/res/mipmap-*/ic_launcher_foreground.png`、`ic_launcher_background.png` | 自适应图标两层，108dp（五种密度），主体高占 62%，落在 66dp 安全区里 |
| 安卓 | `mipmap-*/ic_launcher.png`、`ic_launcher_round.png` | 老式图标，48dp 圆角方形和圆形 |
| 安卓 | `mipmap-anydpi-v26/ic_launcher.xml`、`ic_launcher_round.xml` | 自适应图标的配置 |
| 安卓 | `android/ic_launcher-playstore.png` | 512×512，应用商店用 |
