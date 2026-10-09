# 79 — 聊天里发的图片模型看不到：看图能力按模型目录默认，占位带附件编号，读附件能读图

Status: ready-for-agent
Blocked by: None — can start immediately
Spec: [第一阶段规格](../spec.md) 模型投影（图片只在支持看图的模型上作为图片发送）；ADR 中关于附件的部分

## What to build

用户 2026-10-10 反馈：在聊天框里发了一张图片，助理说识别不了，好像只看到一个引用。

主会话查到的原因（秘书会话 seq 335–347）：

- 图片已经入库（`image` part，带 `mediaId`）。但配置里没写 `models`，`modelVision` 默认一律"不支持"，于是投影成一行占位"[图片：文件名]"。
- 其实 pi-ai 的模型目录里 `deepseek-flash` 的 `input` 是 `["text", "image"]`，支持看图。
- 占位里只有文件名、没有附件编号，助理用 `read_attachment` 去读时报"会话里没有这个附件"；而且 `read_attachment` 本身也只认文本和 PDF。

主会话已在用户的配置里临时加了 `models: { "deepseek/deepseek-flash": { vision: true } }` 先顶上。本票把根子修掉：

- **看图能力默认取 pi-ai 的模型目录**：模型的 `input` 里有 `image` 就算支持；配置里写了 `vision` 的以配置为准（可以关掉）。不再"没写就一律不支持"。
- **不支持看图的模型**：占位带上附件编号（和别的附件一样的写法），说明"这个模型看不了图，可以用 read_attachment 取文字说明"或类似的出路，不让 agent 去猜。
- **`read_attachment` 能读图片**：模型支持看图时，把图作为图片交给它；不支持时，回一句清楚的话。
- 73 号票的"模型"设置页上显示每个模型能不能看图（73 还没做时在 Comments 里留给它）。

## Acceptance criteria

- [ ] 不写配置时，`deepseek-flash` 被认成能看图；配置写 `vision: false` 时不能；有测试。
- [ ] 能看图的模型：用户发的图片作为图片交给模型（历史里的图片也是）；有测试（假模型断言收到了 image 内容）。
- [ ] 不能看图的模型：占位里有附件编号，`read_attachment` 用这个编号能取到；有测试。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 代码：`packages/daemon/src/config/config.ts` 的 `modelVision`、模型投影、`read_attachment` 工具。
- 真机冒烟：合并后请用户在聊天框里再发一次图片。

## Comments
