# 79 — 聊天里发的图片模型看不到：看图能力按模型目录默认，占位带附件编号，读附件能读图

Status: done
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

- [x] 不写配置时，`deepseek-flash` 被认成能看图；配置写 `vision: false` 时不能；有测试。
- [x] 能看图的模型：用户发的图片作为图片交给模型（历史里的图片也是）；有测试（假模型断言收到了 image 内容）。
- [x] 不能看图的模型：占位里有附件编号，`read_attachment` 用这个编号能取到；有测试。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 代码：`packages/daemon/src/config/config.ts` 的 `modelVision`、模型投影、`read_attachment` 工具。
- 真机冒烟：合并后请用户在聊天框里再发一次图片。

## Comments

- **实现**（2026-10-10，从 main `60ad8782` 开工）：
  - **看图能力怎么判**：配置 `models["provider/模型 id"].vision` 写明的为准（可以关掉，也可以打开），没写的按 pi 的模型目录（模型的 `input` 里有 `image` 就算能看：deepseek-flash 能、deepseek-v4-pro 不能；测试里的 faux 也能）。模型目录只有 agent 子进程查得到（ADR-0001/0004 的 pi 边界，守护进程和测试都不能引用 pi），所以：守护进程把配置写明的交进装配参数 `vision`（没写不给，`config.ts` 的 `modelVision` 改成 `configuredVision`，没写返回 `undefined`）；子进程按实际生效的改写会话用的模型的 `input`（`agent-child/session.ts` 的 `withVision`），在 `ready` 里报回实际生效的 `vision`；`AgentSession` 拿它投影输入（就绪之前本来就不交输入），也作为 `HostToolCall.vision` 交给代为执行的工具。改写 `input` 的好处：pi 发请求前按它处理会话里所有的图片，关掉看图后历史里早先发过的图也换成 pi 的占位、不再发；打开时历史里的图每次调用都照样带上。宿主协议升到 13（装配参数 `vision?`、`ready.vision`、`host_tool_result.images?`、`interject.images?`）。
  - **投影第 2 版**（`conversation/projection-v2.ts`，第 1 版原样留着，按 dev.md 的规矩改规则加新版本）：只差图片，图片也带附件引用。看得了图："[图片 n：文件名（附件引用 <id>）]"，图作为图片输入；看不了："[图片：文件名（类型，宽×高，附件引用 <id>）]"，下一行"（这个模型看不了图片，看不到图里的内容，不要猜。要用到图里的内容，请用户用文字说一下；read_attachment 按这个附件引用只取得到图片的基本信息）"。
  - **`read_attachment` 读图**：按引用找到图片后，看得了图时回"附件「x」是图片（类型，宽×高，大小），见下面的图。"并把入库版本作为图片跟在结果后面（子进程放进工具结果；工具调用记录里只有 `[image]` 占位和 `media` 说明）；看不了时回基本信息加"当前的模型看不了图片，读不出图里的内容；要用到图里的内容，请用户用文字说一下。"（不算出错）。工具说明里加了图片这一条。
  - **顺带**：维护者收到的插话带图片时，原先图片丢了（插话只送文字，正文里却写着"[图片 1：…]"），现在看得了图时插话也带图片（`interject.images`，pi 的 `steer` 本来就收图片）。
  - **示例配置**去掉了 `models["deepseek/deepseek-flash"].vision: false`（复制示例会把看图关掉）。用户数据目录里主会话临时加的 `vision: true` 照样有效（和目录一致），可以留着也可以删。
  - **73 号票**还没做：设置页显示每个模型能不能看图的做法留在 73 的 Comments 里。
  - **测试**：`test/contract/vision.contract.test.ts`（新）：不写时 deepseek-flash 的 `ready.vision` 是 true、v4-pro 是 false，写明的为准，faux 是 true；deepseek-flash 接本机回放的服务（不联网），图片作为 `image_url` 发出、下一轮历史里的图也在，接着同一会话把看图关掉后请求里不再有 `image_url`、换成 pi 的 "image omitted"；宿主工具结果带图片、插话带图片都进了模型的上下文。`test/main/attachments.test.ts`：不写配置时秘书收到图片（假模型回显里有 `[image image/png]`，第二轮历史里的也在）；写明 `vision: false` 时占位里有附件引用，`read_attachment` 用这个引用取到基本信息和那句话；看得了图时 `read_attachment` 把图交给模型。`test/model-projection.test.ts`：第 1 版的用例钉在第 1 版，加第 2 版的图片两种写法和"图片之外逐字同第 1 版"；`test/config.test.ts` 改成 `configuredVision`。
  - **说明**：`docs/dev.md`（模块表、投影第 2 版、秘书的输入、read_attachment、宿主工具的结果、AgentSession 的 `configuredVision`、配置的模型能力）、规格的"发给模型前的投影"和"附件"两条。
- **测试结果**：变基到 main `265c2b64` 后，`ERGOU_TEST_WORKERS=2 npx vitest run` 221 个文件 3374 条全过；`npm run typecheck`、`npx oxlint` 无报错。真机冒烟（聊天框里再发一次图片）等合并、经 LSM 重启后请用户试。

- 2026-10-10 完成：主会话核过改动（投影按惯例加第 2 版、宿主协议升 13）；全量 3374 条通过。压缩合并进 main，经 LSM 重启；请用户在聊天框里再发一次图片做真机冒烟。
