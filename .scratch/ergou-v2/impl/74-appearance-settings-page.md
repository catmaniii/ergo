# 74 — 设置里"外观与风格"合成一项，点进去才是具体选项

Status: done
Blocked by: 54（54 号票在改"更多"页，去掉缩放原型的入口）
Spec: [第一阶段规格](../spec.md) 第 22 节外观；34 号票（浅色、深色、跟随系统）、39 号票（风格）

## What to build

用户 2026-10-10 定：

- 外观（浅色 / 深色 / 跟随系统）和风格现在直接摊在设置列表的最上面。改成：**两者合成设置里的一项"外观与风格"**，和别的设置项一样带 `›`，点进去是下一级页面，才显示具体选项。
- 下一级页面里：上面是外观三个选项，下面是风格；风格的预览照旧。
- **风格目前只有两套**：经典、净白格栅。其余视觉风格（40–42、46–51 号票）后续再加，这次不做。
- 设置列表上这一项的副标题显示当前选的，比如"跟随系统 · 净白格栅"。
- 宽屏照设置页现有的分栏做法：左边列表、右边下一级页面；窄屏点进去、返回键回来。

## Acceptance criteria

- [x] 设置列表里不再直接摊外观和风格的选项，只有"外观与风格"一项；点进去能改，改完立即生效、刷新后保持。
- [x] 宽窄屏、两套风格、浅色深色都看过；截图写进 Comments。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 代码：`pages/MorePage.tsx` 的 `SettingsList`、`pages/more/AppearancePicker.tsx`、`StylePicker.tsx`。
- 个人助理的名字（43 号票）照旧在列表最上面。

## Comments

- **实现**（2026-10-10，从 main `5114a2f3` 开工；54 号票还在做，按主会话的决定先开工）：
  - **地址**：设置下面多一页 `appearance`（`#/more/appearance`，`app/route-hash.ts` 的 `MORE_PAGES`、`SETTINGS_PAGES`），属于主导航的设置。宽窄屏照设置页现有的分栏，没加新的写法：设置直接在导航里时，宽屏左边设置列表、右边这一页（`SettingsSection`）；设置收进"更多"时，宽屏是"更多"菜单里的设置列表 + 右边这一页；窄屏点进去，标题栏的 ‹（鸿蒙 App 的系统返回键也走它）回到设置列表。
  - **设置列表**（`pages/MorePage.tsx` 的 `SettingsList`）：个人助理的名字照旧在最上面（开在鸿蒙 App 里时那一行更上面），下面第一项是"外观与风格"，和别的设置项一样带 `›`；副标题是现在选的（`AppearanceSummary`，比如"跟随系统 · 净白格栅"，在下一级页面里改了当场跟着变）。设置的说明里"外观"改成"外观与风格"。
  - **下一级页面** `pages/more/AppearancePage.tsx`（原来的 `AppearancePicker.tsx` 改名，和设置下面别的页一样叫 `…Page`）：两节（`Section`）——上面"外观"（说明"只对这台设备生效；系统现在是…" + 三个选项，`Segmented role="radio"`），下面"风格"（说明 + `StylePicker`，预览照旧）。三个选项的名字挪到状态层 `state/theme.ts` 的 `THEME_CHOICE_LABEL`，和副标题共用；副标题由 `appearanceSummary(选择, 风格的名字)` 拼（状态层不认具体有哪几套风格，名字由界面从风格清单里取）。
  - **样式**（`styles/pages.css`）：去掉原来摊在列表里的 `.appearance`、`.appearance-sub`；新的 `.appearance-choice`：三个选项平分一行，最宽 420px（宽屏右边那一栏有九百多宽，拉满了三个字隔得太开）。风格格子没改（右边那一栏窄的时候照样按容器查询排成一列、预览在左），注释跟着改了。
  - **风格只有经典、净白格栅两套**：风格清单本来就只登记了这两套，没动。
  - 顺带的变化：设置里预览用的字体样式表（`preview.css`）是 `StylePicker` 挂上时挂的，现在只在进这一页时才挂，打开设置列表不再为预览多下字体。
  - **没碰 54 号票的地方**：`App.tsx`（顶上的原型工具条）、"更多"里的原型入口都没动，只改了设置列表里外观和风格那一块。
  - **测试**：`test/app/route.test.ts` 加一条（`#/more/appearance` 拆得开、拼得回、属于设置）；`test/state/theme.test.ts` 加副标题的表格（3 行）和三个选项的名字。页面本身没有组件测试切面（规格 Testing Decisions），靠下面的截图。
  - **说明**：`docs/dev.md` 的状态层条目（`THEME_CHOICE_LABEL`、`appearanceSummary`）、"外观"一节（设置里的入口）、"视觉风格"一节（在设置里的位置、预览字体什么时候挂、加风格第 6 步）跟着改了。
- **浏览器检查**（agent-browser 自己的无头会话，直接开构建产物 `file://`，没起服务、没碰 8810/8811，看完关了会话）。截图在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t74\`：
  - **390 宽**（设置收在"更多"里）：`390-{classic,grid}-{light,dark}-{list,page}.png` 共 8 张。设置列表上外观和风格不再摊开，只有"外观与风格"一项带 `›`，副标题分别是"跟随系统 · 经典""深色 · 经典""浅色 · 净白格栅""深色 · 净白格栅"；点进去标题栏是"外观与风格"带 `‹`，上面外观三个选项、下面风格两格（每格浅深两张预览），`‹` 回到设置列表。
  - **改了立即生效、刷新后保持**：在这一页点"净白格栅""深色"，根元素当场变成 `data-style="grid"`、`data-theme="dark"`，localStorage 是 `ergou-style=grid`、`ergou-theme=dark`；刷新后还停在这一页、这两项选中，回到列表副标题是"深色 · 净白格栅"。
  - **1280×800**（设置在竖栏里）：`1280-{classic,grid}-{light,dark}.png` 共 4 张，左边设置列表里"外观与风格"是选中的样子（经典是浅蓝底，净白格栅是墨色块、深色下反成浅色块），右边这一页。`1280-classic-system-dark.png`：系统深色、选跟随系统，说明写"系统现在是深色"，副标题"跟随系统 · 经典"；`1280-grid-system-dark.png`：在右边点净白格栅，左边的副标题当场变成"跟随系统 · 净白格栅"。
  - **1280×460**（竖栏放不下，设置收进"更多"）：`1280x460-grid-system-dark-folded.png`，"更多"菜单里的设置列表 + 右边这一页，也对。
  - 两套风格在浅色、深色下都看得清；净白格栅下"外观""风格"两个小节标题是它已有的 `.sec-head h3` 样子（小号粗体），和别的设置页一致。
- **测试结果**：`ERGOU_TEST_WORKERS=2 npx vitest run --project web` 57 个文件 1001 条全过；`npm run typecheck`、`npm run lint`（oxlint）无报错。

- 2026-10-10 完成：主会话看过截图（390 净白格栅浅色的列表和下一级页面、1280 经典深色分栏）和改动，web 1001 条通过。压缩合并进 main。
