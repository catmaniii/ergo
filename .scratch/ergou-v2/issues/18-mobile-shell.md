# 移动端外壳（鸿蒙单框架 / Android）

Type: grilling
Status: open
Phase: 2（暂缓，第一阶段规格之后再做）
Blocked by: 06, 07

## Question

1. **UI 来源**：外壳把 Web UI 打包在本地，还是从远程加载？
2. **JS 桥**：需要暴露哪些 API？
   - 推送 token；
   - 点击通知后跳到对应页面；
   - 生物识别；
   - 录音；
   - 文件选择和分享。
3. **安全上下文与麦克风**：怎样满足安全上下文，怎样拿到麦克风权限。
4. **复用**：AgentSense 的 ArkWeb 壳（`AgentSense/entry`）能复用多少。

## Context

- `docs/research/01-ref-agentsense.md` §3：ArkWeb 壳和 NativeBridge。
- `docs/research/07-push-harmonyos-android.md` §4：JS 桥草图。
- `docs/research/09-chat-multimedia.md`：ArkWeb 对录音格式的支持还没核实。
- 立项 grilling Q16：Web 封装成鸿蒙单框架应用和 Android 应用，用来拿到系统推送。
