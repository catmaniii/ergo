# 34 — 外观：浅色、深色、跟随系统

Status: done
Blocked by: 02（Web UI 骨架与可点击原型）, 33（主导航按空间自适应）
Spec: [第一阶段规格](../spec.md) 第 19 节（Web UI）

## What to build

设置里加一项"外观"，三个选项：浅色、深色、跟随系统（默认）。选了马上生效，不用刷新；选"跟随系统"时，系统切换深浅色，页面跟着变。选择按设备记住（存在这台设备的浏览器里），手机和电脑可以各设各的；没选过就是跟随系统。打开页面时直接按记住的外观画出来，不先闪一下另一种颜色。

## Acceptance criteria

- [x] 前端状态层：一个纯函数按"用户选的外观"和"系统现在是不是深色"算出实际用哪种；表格测试覆盖三个选项 × 系统深浅两种。读写记住的选择出错（存储不可用、值不认识）时按跟随系统处理。
- [x] 样式：颜色 token 在浅色、深色下各一套；选浅色时即使系统是深色也用浅色，选深色时即使系统是浅色也用深色，跟随系统时照系统。现有页面（秘书聊天、待我处理、任务看板和详情、项目页、更多和设置各页、配对页、语音气泡和录音面板）在两种外观下都看得清，不出现某处还按系统颜色画的情况。
- [x] 设置里有"外观"一项，三个选项，当前选中的有标示；选了立刻生效；系统深浅色变化时，跟随系统的页面实时跟着变。
- [x] 打开页面不闪：在页面脚本加载前就按记住的选择定下外观（比如 `index.html` 里一小段内联脚本设 `data-theme`），`color-scheme` 和移动端浏览器地址栏的颜色跟着外观走。
- [x] 组件测试或回放测试覆盖：选深色后根元素带上对应标记、选跟随系统时去掉；在本机浏览器里浅色、深色、跟随系统各看一遍，结果写进 Comments。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 现在深色只靠 `@media (prefers-color-scheme: dark)`（`styles/base.css`、`styles/look.css`），`index.html` 里 `color-scheme` 是 `light dark`。改成：浅色 token 放 `:root`，深色 token 同时挂在 `:root[data-theme="dark"]` 和 `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` 下，两处共用一份定义，别抄两遍。
- 外观是这台设备的偏好，不是个人数据，也不进守护进程的配置；不经协议。
- 设置的入口照 33 号票的导航：设置页里加一项，或者在设置页顶部直接放三个选项，选简单的那种。

## Comments

- **实现**（2026-10-08）：
  - 前端状态层 `state/theme.ts`：`resolveTheme(选择, 系统是不是深色)` 算实际用哪种；`themeChoiceOf(存的值)` 认不出（没选过、旧值、被改过）就是跟随系统。表格测试在 `test/state/theme.test.ts`。
  - 浏览器那一半 `app/theme.ts`：`themeControllerIn(env)` 读记住的选择（localStorage 的 `ergou-theme`；跟随系统就是擦掉这个键）、给页面挂三处——根元素的 `data-theme`（浅色、深色挂上，跟随系统去掉）、`<meta name="color-scheme">`（light / dark / light dark）、`<meta name="theme-color">`（地址栏，和标题栏底色 `--surface` 一致：#ffffff / #1d1f24）——并监听 `prefers-color-scheme` 的变化（换地址栏颜色、通知界面）。存储用不了时按跟随系统开场，选了照样在这次打开里生效、不抛错。`app/page-theme.ts` 把它接到真的 `document`、`localStorage`、`matchMedia` 上（单独一个文件，`app/theme.ts` 不碰浏览器全局变量，能在 Node 里测），`main.tsx` 开场取一次。
  - 不闪：`index.html` 的 `<head>` 里一段内联脚本，在页面脚本和样式之前按记住的选择挂好那三处。它和 `app/theme.ts` 做同一件事，`test/app/theme.test.ts` 把内联脚本从 `index.html` 里拿出来，在假页面上跑，和 `themeControllerIn` 挂出来的结果逐项比对（记住的值 5 种 × 系统深浅 2 种），改一处忘了另一处会红。构建产物里内联脚本原样保留（已看过 `dist/index.html`）。
  - 设置入口：按 Notes 选简单的那种，设置列表顶上直接放"外观"三个选项（`pages/more/AppearancePicker.tsx`，`role="radiogroup"`，选中的高亮），设置在导航里还是收进"更多"、宽屏还是竖屏都在同一个列表里。跟随系统时下面一行小字说"系统现在是深色/浅色"，系统切了跟着变。没加新路由，`route.ts` 没动。
- **样式的写法（和 Notes 字面略有不同）**：纯 CSS 里一块声明没法同时挂在一个受媒体查询约束、一个不受约束的选择器下，要么抄两遍、要么换个开关。所以开关只放一个——根元素的 `color-scheme`：`:root` 是 light；`:root[data-theme="dark"]` 和 `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` 两处切成 dark（就是 Notes 说的那两个位置）。颜色 token 每个只写一次 `--bg: light-dark(浅色, 深色)`，浅深两个值并排，两处共用这一份，没有抄两遍；`color-scheme` 也就天然跟着外观走（表单控件、滚动条一起变）。`look.css` 里的三个（`--muted`、`--you`、`--you-bg`）同样改成 `light-dark()`，原来的两段 `@media (prefers-color-scheme: dark)` 都删了，样式里不再有直接按系统颜色画的地方。
  - 兼容：`light-dark()` 要 Chrome/Edge 123、Safari 17.5、Firefox 120 起。构建时 Vite 8 用 Lightning CSS 压缩 CSS，按构建目标（es2022，比这些都老）自动把它降成两个开关变量（`--lightningcss-light` / `--lightningcss-dark`，挂在上面三处 `color-scheme` 旁边），所以老一点的 WebView、ArkWeb 照样能切；已核对 `dist/index.html` 里没有残留的 `light-dark(`。开发服务器（`vite dev`）不降级，用新浏览器看就行。
  - 以后加颜色 token：浅深两个值都写在 `light-dark()` 里（`base.css` 开头的注释写了）；只有一个值的（比如 `--primary-text`）照旧。
- **本机浏览器检查**（agent-browser 自己的无头会话，直接开构建产物 `dist/index.html`（file://，原型假数据最全），不起服务、没碰 8810/8811，看完关掉了会话；用 `set media light/dark` 模拟系统深浅色）：
  - 跟随系统：系统浅色、深色下秘书页分别是浅色、深色；页面开着时切系统深浅色，颜色、地址栏颜色（`theme-color` 在 #ffffff 和 #1d1f24 之间变）、设置里"系统现在是…"那行都实时跟着变。
  - 系统浅色时选深色：点下去立刻变深，`data-theme="dark"`、`color-scheme` meta 是 dark、地址栏 #1d1f24；待我处理、任务看板、任务详情（含计划变更卡）、项目列表、项目页（定时作业、工单流水线）、配对等待页、配对批准页、语音设置、关注类别（原生下拉框也是深色）、消耗页、秘书页的语音气泡、"没有麦克风权限"提示条，都看得清，没有哪块还是浅色。
  - 系统深色时选浅色：设置、秘书、待我处理、任务详情、项目页、配对批准页、关注类别（下拉框是浅色）、配对等待页都是浅色，没有哪块还按系统画成深色。
  - 录音面板：无头浏览器没有麦克风，按住说话只出"没有麦克风权限"的提示（两种外观下都看得清）；于是照 `VoiceInput.tsx` 的结构在页面上摆了两个静态面板（普通、上滑取消），浅色、深色下都看得清。
  - 宽屏（1280×800）：设置在左边竖栏里，外观三个选项在 280 宽的列表里放得下。
  - "不闪"在浏览器里没法肉眼抓帧，靠上面的内联脚本测试和构建产物里脚本的位置（在 `<head>` 里、模块脚本和样式之前）保证。
- **评审后的修改**（2026-10-08）：
  - 约定写进 `docs/dev.md`：前端状态层的条目加了 34 号票，另起"外观（34 号票）"一节（状态层、浏览器层、内联脚本各管什么和两边怎么对齐；新加颜色 token 用 `light-dark()` 写浅深两个值；地址栏颜色写在哪几处；`light-dark()` 的回退和检查）。
  - 设置里的三个选项改用 `ui/common.tsx` 的 `Segmented`：加了 `role`（默认 `tab`；`radio` 时是 `radiogroup` + `aria-checked`）和 `label`。`revoked-mark.ts` 的 `MarkStorage` 和外观的存储类型合成 `app/device-storage.ts` 的 `DeviceStorage`。
  - 地址栏颜色：`test/app/theme.test.ts` 从 `base.css` 读出 `--surface` 的浅深两个值，比对 `index.html` 里 meta 的初始值、内联脚本、`app/theme.ts` 给出的颜色（测试里不再自己抄一份）；改坏内联脚本的颜色试过，会红。
  - `vite.config.ts` 明写 `build.cssMinify: "lightningcss"` 和 `build.cssTarget`（Chrome/Edge 94、Firefox 93、Safari/iOS 16.4，就是原来 es2022 的换算，产物不变）。新加 `test/build.test.ts`：照配置构建一遍（按生产环境、不写盘，半秒多，跟 check 一起跑），断言产物的 CSS 里没有 `light-dark(`、有降级出来的开关变量，内联脚本在 `<head>` 里、在页面脚本和样式之前；把 cssTarget 改成新浏览器试过，会红。
  - 变基到 18 号票之后（`state/index.ts` 的导出冲突，两行都留），看了范围记录（18 号票）在两种外观下：系统浅色时选深色、系统深色时选浅色，项目页（记账本）的范围记录一节、任务详情（家庭照片整理与去重）"消耗"栏里的范围记录都看得清。原型里真项目的 `ScopeRecordList` 出不来，照 `ui/scope-records.tsx` 的结构在项目页那一节摆了一份静态的（越界、范围变更两组，带依据、展开的说明），两种外观下也都看得清；18 号票加的样式只用 token。

- 2026-10-08 完成：经评审并按意见修改（dev.md 写明外观约定、复用 Segmented、地址栏颜色和 --surface 的比对测试、light-dark() 的回退写进 vite 配置并有构建断言）后压缩合并进 main。
