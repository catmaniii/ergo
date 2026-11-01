# 09 聊天多媒体：消息模型、语音、UI 组件、DeepSeek V4.1 与成本

> 调研日期：2026-10-07。范围是二狗 v2 聊天层的六个问题：① Telegram/WhatsApp 消息模型；② 语音消息 UX 与浏览器录音；③ React 聊天 UI 组件的 parts 模型；④ DeepSeek V4.1 官方能力；⑤ 成本估算；⑥ ergo 消息数据模型建议。
>
> 标注约定：每条事实都附来源 URL。【判断】【建议】是本文的推论；【未核实】是没能在一手资料里确认的内容；【估算】是按假设算出来的数字。
>
> 方法：只用一手资料，包括官方文档、API reference、规范、源码、npm registry。DeepSeek 文档逐页抓取原文核对；pi-ai 核对的是 `main@ae92585`（2026-10-06）和 npm `1.0.4` 的发布包。

## 0. 结论速览（给决策用）

1. **DeepSeek 现状和预期不一样**：
   - 官方 model ID 是 **`deepseek-flash`**（= V4.1 Flash，2026-09-10 发布）和 `deepseek-v4-pro`（= V4-Pro-0813）。**V4.1 Pro 还没有发布**。
   - Flash **原生能看图**（JPEG/PNG/GIF/WebP，每张 ≤1024 token），但**不支持音频、PDF/文档、视频**。V4-Pro 是纯文本模型。
   - 上下文 1M，最大输出 384K，默认开启思考。**带 tools 时必须回传全部历史 `reasoning_content`**。
   - 价格分高峰/空闲两档，空闲半价。Flash 高峰价：输入命中 $0.006、未命中 $0.30、输出 $1.20（每百万 token）。
2. **pi-ai 原生支持**：provider 是 `deepseek`，内置 `deepseek-flash`（text+image）和 `deepseek-v4-pro`，`thinkingFormat:"deepseek"`。有两个坑：
   - 不传 `reasoningEffort` 时，pi-ai 会**关掉思考**；
   - 目录里的 cost 按高峰价计，空闲时段会高估 2 倍。
3. **成本很低，关键在缓存命中率**【估算】：
   - 对话 50 轮/天：约 $0.07–0.14；
   - 一个 100 步长程任务：$0.10–0.86；
   - 一个四角色项目跑一天：$0.9–5.8；
   - 夜间记忆整理：约 $0.1。
   - 缓存未命中价是命中价的 50 倍，所以前缀稳定性比模型单价重要得多。
4. **消息模型**：用"信封 + 有序 parts"，形状上靠近 AI SDK 的 UIMessage parts，再补上 Telegram/WhatsApp 的 messenger 字段（引用、反应、编辑、相册、语音波形、已读）。媒体按 sha256 内容寻址，存在个人数据目录。卡片是可原地更新的 typed part，按钮语义照搬 Telegram 的 callback_query。
5. **语音**：
   - 浏览器端按运行时探测结果选格式：能录 opus 就录 opus，否则录 mp4/aac。服务端统一用 ffmpeg 转成 16 kHz mono WAV 交给 Whisper。
   - WebView 里要同时过两道权限：系统权限，以及 WebView 的 `onPermissionRequest` 授权。
   - TTS 按句流式合成，最终挂成 `voice(origin:"tts")` part。
6. **UI 选型**：
   - **继续手写 React 19 + CSS，数据模型和流协议对齐 AI SDK v7 的 `UIMessage` parts / `UIMessageChunk`**，用 `data-*` 承载语音、卡片等 ergo 自有的 part。
   - 其他候选为什么不选：
     - assistant-ui：只作备选（没有语音消息、反应、相册，还会引入 Tailwind 和 Radix）；
     - stream-chat-react：绑定 Stream 云，许可证专有；
     - 阿里 ChatUI：在 React 19 下有硬伤；
     - chatscope：已经停更。
   - 借鉴 OpenClaw：实时增量和持久化历史分开，历史是唯一的权威数据。
7. **部署前提**：`getUserMedia` 要求 secure context。用 `http://局域网IP` 打开 UI 时麦克风直接不可用，所以 daemon 必须提供 HTTPS，或者 App 内用 https 源加载打包好的 UI。

## 目录

1. Telegram 与 WhatsApp 的消息模型（§1）
2. 语音消息 UX 与浏览器录音实现（§2）
3. React 聊天 UI 构件与 parts 模型（§3）
4. DeepSeek V4.1（Flash / Pro）官方现状，以及 pi-ai 的支持情况（§4）
5. 粗略成本模型（§5）
6. 建议：ergo 的消息数据模型（§6）
7. 开放问题（§7）

## 1. Telegram 与 WhatsApp 的消息模型

> 来源版本：
> - Telegram Bot API 当前为 10.3（2026-08-24，见 [Bot API recent changes](https://core.telegram.org/bots/api#recent-changes)）；MTProto 的 constructor 页标注为 Layer 225（[message](https://core.telegram.org/constructor/message)）。
> - WhatsApp Cloud API 的文档已经迁到 `developers.facebook.com/documentation/business-messaging/whatsapp/…`，旧路径 `/docs/whatsapp/cloud-api/…` 用 curl 访问返回 400。官方页面索引见 [llms.txt](https://developers.facebook.com/documentation/business-messaging/whatsapp/llms.txt)，示例 API 版本是 v25.0。

### 1.1 Telegram 的消息与媒体类型

**Bot API 的 `Message` 对象**（[#message](https://core.telegram.org/bots/api#message)）

- **身份字段**：
  - `message_id`：只在本 chat 内唯一，ephemeral 消息为 0；
  - `chat`、`from` / `sender_chat`、`date`（Unix 秒）、`edit_date`、`message_thread_id`。
- **没有 `type` 字段，靠"哪个可选字段有值"来判断消息类型**。可能的字段有：`text`、`animation`、`audio`、`document`、`live_photo`、`paid_media`、`photo`（PhotoSize 数组）、`sticker`、`story`、`video`、`video_note`、`voice`、`checklist`、`contact`、`dice`、`game`、`poll`、`venue`、`location`、`rich_message`。
- **为兼容保留的冗余字段**：发 animation 时 `document` 也有值；venue 附带 location；live_photo 附带 photo。
- **文本 + entities**：
  - `text` 为 1–4096 字符（[sendMessage](https://core.telegram.org/bots/api#sendmessage)）。
  - `MessageEntity` 的类型有：mention、hashtag、cashtag、bot_command、url、email、phone_number、bold、italic、underline、strikethrough、spoiler、blockquote、expandable_blockquote、code、pre（带 language）、text_link、text_mention、custom_emoji、date_time（[#messageentity](https://core.telegram.org/bots/api#messageentity)）。
  - offset 和 length **按 UTF-16 code unit 计**（[api/entities](https://core.telegram.org/api/entities)）。
- **caption**：`caption` + `caption_entities`，0–1024 字符；还有 `show_caption_above_media` 和 `has_media_spoiler`（[#message](https://core.telegram.org/bots/api#message)、[sendPhoto](https://core.telegram.org/bots/api#sendphoto)）。

**voice 和 audio 的区别**

- **`Voice` 用于语音留言**（[#voice](https://core.telegram.org/bots/api#voice)、[sendVoice](https://core.telegram.org/bots/api#sendvoice)）：
  - 字段只有 file_id、file_unique_id、duration、mime_type、file_size，**Bot API 里没有 waveform**。
  - `sendVoice` 接受 OGG(OPUS)、MP3、M4A，上限 50 MB。
  - 用 URL 发送时必须是 audio/ogg 且不超过 1 MB；1–20 MB 的会被当成文件发送（[sending files](https://core.telegram.org/bots/api#sending-files)）。
- **`Audio` 用于音乐**（[#audio](https://core.telegram.org/bots/api#audio)、[sendAudio](https://core.telegram.org/bots/api#sendaudio)）：
  - 带 performer、title、file_name，thumbnail 作专辑封面；
  - 进入客户端的音乐播放器；
  - `sendAudio` 只接受 MP3 和 M4A。
- **MTProto 层**：两者都是 Document 加 `documentAttributeAudio`，用 `voice` flag 区分；`waveform` 是 "a series of bitpacked 5-bit values"（[documentAttributeAudio](https://core.telegram.org/constructor/documentAttributeAudio)）。`messageMediaDocument` 上也有 voice、round、video 这几个 flag（[MessageMedia](https://core.telegram.org/type/MessageMedia)）。

**视频与图片**

- **圆形视频（VideoNote）**：用 `length` 表示直径（[#videonote](https://core.telegram.org/bots/api#videonote)）。在 MTProto 里对应 `documentAttributeVideo.round_message`。这个 attribute 还有：
  - `supports_streaming`、`nosound`；
  - `duration`（double 类型）、`w` / `h`；
  - `video_codec`（[documentAttributeVideo](https://core.telegram.org/constructor/documentAttributeVideo)）。
- **Video**：有 thumbnail、cover、start_timestamp、qualities 等字段（[#video](https://core.telegram.org/bots/api#video)）。
- **photo**：是同一张图的多个尺寸组成的数组（[#photosize](https://core.telegram.org/bots/api#photosize)）。MTProto 另有 `photoStrippedSize`（type `i`），是一张极低清的内嵌缩略图，用作加载占位（[api/files](https://core.telegram.org/api/files)）。

**相册（album）**

- `sendMediaGroup` 接受 2–10 项。photo、live photo、video 可以混排；"Documents and audio files can be only grouped in an album with messages of the same type"（[sendMediaGroup](https://core.telegram.org/bots/api#sendmediagroup)）。
- MTProto 用共享同一个 `grouped_id` 来表示相册，每组最多 10 个。客户端只有在"恰好一张图带 caption"时，才把它显示成整个相册的 caption（[constructor/message](https://core.telegram.org/constructor/message)、[api/files](https://core.telegram.org/api/files)）。
- **结论：相册是 N 条独立消息共享一个 group id，而不是一条消息挂多个附件。**

**MTProto 的 `message` 构造**（[constructor/message](https://core.telegram.org/constructor/message)）

- 字段包括：`id`、`peer_id`、`from_id`、`date`、`message`、`media:MessageMedia`、`entities`、`reply_to`、`fwd_from`、`edit_date`、`edit_hide`、`grouped_id`、`reactions`、`reply_markup`、`media_unread`、`noforwards`、`invert_media`。
- MessageMedia 的取值有 Photo、Document、Geo/GeoLive、Contact、Venue、Poll、Dice、WebPage、Story、PaidMedia、ToDo 等（[MessageMedia](https://core.telegram.org/type/MessageMedia)）。

### 1.2 回复/引用、编辑、删除、反应、转发（Telegram）

- **回复与引用**
  - 发送时用 `reply_parameters`（[#replyparameters](https://core.telegram.org/bots/api#replyparameters)）：
    - 字段有 message_id、chat_id（跨 chat 回复时用）、allow_sending_without_reply；
    - `quote` 为 0–1024 字符，**必须是原文的精确子串**，否则发送失败；
    - 还有 `quote_position`（按 UTF-16 计）。
  - 接收时有三种字段：
    - `reply_to_message`：只用于同 chat、同 thread 的回复，而且不会再嵌套下一层（[#message](https://core.telegram.org/bots/api#message)）；
    - `external_reply`：来自别的 chat 或 topic 的回复，带原消息来源和媒体快照（[#externalreplyinfo](https://core.telegram.org/bots/api#externalreplyinfo)）；
    - `quote`：类型是 `TextQuote{text, entities, position, is_manual}`（[#textquote](https://core.telegram.org/bots/api#textquote)）。
  - MTProto 的 `messageReplyHeader` 有 reply_to_msg_id、quote_text、quote_offset、reply_to_top_id（[messageReplyHeader](https://core.telegram.org/constructor/messageReplyHeader)）。
- **编辑**
  - 方法有 `editMessageText`、`editMessageCaption`、`editMessageMedia`、`editMessageReplyMarkup`（[editMessageText](https://core.telegram.org/bots/api#editmessagetext)）。
  - 相册编辑有限制：音频相册里只能换成音频，文档相册里只能换成文档（[editMessageMedia](https://core.telegram.org/bots/api#editmessagemedia)）。
  - 用户编辑消息时，bot 收到 `edited_message` 更新（[#update](https://core.telegram.org/bots/api#update)）。
  - MTProto 有 `edit_hide` 字段；错误码 `MESSAGE_EDIT_TIME_EXPIRED` 说明存在编辑时间窗（[messages.editMessage](https://core.telegram.org/method/messages.editMessage)）。
  - bot 编辑自己发的消息有没有时限，文档没写【未核实】。
- **删除**
  - `deleteMessage` 只能删 48 小时内的消息（[deleteMessage](https://core.telegram.org/bots/api#deletemessage)）；`deleteMessages` 一次可删 1–100 条（[deleteMessages](https://core.telegram.org/bots/api#deletemessages)）。
  - **普通聊天里没有"消息被删除"的 Update**，只有 business 场景下有 `deleted_business_messages`（[#update](https://core.telegram.org/bots/api#update)）。
  - MTProto 的 `messages.deleteMessages` 有 `revoke` 参数（"delete for all participants"，[deleteMessages](https://core.telegram.org/method/messages.deleteMessages)）。
- **反应（reactions）**
  - `setMessageReaction`：bot 按非 Premium 用户算，每条消息最多 1 个反应；给相册设置时落在组内第一条（[setMessageReaction](https://core.telegram.org/bots/api#setmessagereaction)）。
  - `ReactionType` 有三种：Emoji、CustomEmoji、Paid（[#reactiontype](https://core.telegram.org/bots/api#reactiontype)）。
  - 变更通过 `MessageReactionUpdated` 以差量 `{old_reaction, new_reaction}` 下发（[#messagereactionupdated](https://core.telegram.org/bots/api#messagereactionupdated)）。要收到它，必须在 allowed_updates 里显式订阅，且 bot 需要是管理员（[#update](https://core.telegram.org/bots/api#update)）；私聊里能否收到【未核实】。
- **转发**
  - `forward_origin` 的类型是 `MessageOrigin`，分 User、HiddenUser、Chat、Channel 四种（[#messageorigin](https://core.telegram.org/bots/api#messageorigin)）。
  - `forwardMessage` 保留到原消息的链接；`copyMessage` 不保留链接，可以改 caption（[forwardMessage](https://core.telegram.org/bots/api#forwardmessage)、[copyMessage](https://core.telegram.org/bots/api#copymessage)）。

### 1.3 送达与已读

**Telegram**

- **bot 拿不到已读回执**：Update 列表里没有任何 delivered 或 read 事件（[#update](https://core.telegram.org/bots/api#update)）。MTProto 的 `messages.readHistory` 标注为 "Only users can use this method"（[readHistory](https://core.telegram.org/method/messages.readHistory)）。
- **用户侧的已读是会话级水位线，不是逐条状态**：
  - `dialog` 上有 `read_inbox_max_id`、`read_outbox_max_id`、`unread_count`（[dialog](https://core.telegram.org/constructor/dialog)）；
  - 通过 `updateReadHistoryOutbox{peer,max_id}` 推送（[updateReadHistoryOutbox](https://core.telegram.org/constructor/updateReadHistoryOutbox)）；
  - `media_unread` 标记语音或视频还没被播放（[constructor/message](https://core.telegram.org/constructor/message)）。
- **"正在输入"状态**：`sendChatAction` 支持 typing、upload_photo、record_voice 等，持续 ≤5 秒，bot 一发出消息就清除（[sendChatAction](https://core.telegram.org/bots/api#sendchataction)）。MTProto 里上传类动作带 `progress` 字段（[SendMessageAction](https://core.telegram.org/type/SendMessageAction)）。

**WhatsApp**

- 发送接口的响应只代表"已接受"，送达情况靠 webhook 回报（[send-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)）。
- `statuses[].status` 的取值：`sent`（一个勾）、`delivered`（两个勾）、`read`（蓝勾）、`failed`（附 errors[]）（[status webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)）。
  - `read` 隐含 `delivered`，所以 delivered 可能不会单独出现。
  - 2026-03-17 起新增 `played`，表示语音第一次被播放（[audio-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages)）。
- **消息顺序不保证**，默认 TTL 30 天（[send-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)）。
- **标记已读**：`POST /PHONE_NUMBER_ID/messages`，body 为 `{"status":"read","message_id":…}`，会连带把更早的消息也标成已读，同样是水位线语义（[mark-message-as-read](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/mark-message-as-read)）。
- **正在输入**：同一个请求里加 `"typing_indicator":{"type":"text"}`，回复后或 25 秒后消失（[typing-indicators](https://developers.facebook.com/documentation/business-messaging/whatsapp/typing-indicators)）。

### 1.4 媒体上传与下载

**Telegram Bot API**

- **三种发送方式**（[sending files](https://core.telegram.org/bots/api#sending-files)）：
  - 用 `file_id` 复用：不限大小；
  - 用 URL：照片 ≤5 MB，其他 ≤20 MB；
  - multipart 上传：照片 ≤10 MB，其他 ≤50 MB。
- **`file_id` 与 `file_unique_id` 的区别**：
  - `file_id` 能下载、能复用，但对每个 bot 不同；
  - `file_unique_id` 跨时间、跨 bot 都不变，但不能用来下载或复用（[#photosize](https://core.telegram.org/bots/api#photosize)）；
  - 用 file_id 复用时不能改媒体类型。
- **下载**：`getFile` 拿到 `file_path`，然后访问 `https://api.telegram.org/file/bot<token>/<file_path>`。链接至少 1 小时有效，**bot 最多只能下载 20 MB**（[getFile](https://core.telegram.org/bots/api#getfile)）。
- **Local Bot API Server**：下载不限大小，上传上限 2000 MB（[local server](https://core.telegram.org/bots/api#using-a-local-bot-api-server)）。
- **缩略图（thumbnail）**：JPEG，<200 kB，宽高都 ≤320，只能随新上传一起提交（[sendVideo](https://core.telegram.org/bots/api#sendvideo)）。
- `sendVideo` 有 `supports_streaming` 参数（[sendVideo](https://core.telegram.org/bots/api#sendvideo)）。
- `file_size` 可能超过 2^31，要用 int64 或 double 存（[#audio](https://core.telegram.org/bots/api#audio)）。

**MTProto**（[api/files](https://core.telegram.org/api/files)）

- **上传**：
  - 客户端自己生成 64-bit 的 file id；
  - 分片大小需满足 `part_size % 1024 == 0` 且 `524288 % part_size == 0`，即最大 512 KB；
  - 大于 10 MB 的文件用 `upload.saveBigFilePart`；
  - 分片可以多路并行上传。
- **流式上传**：长度未知时，`file_total_parts = -1`，直到最后一片才填真实值。这个机制可以直接借鉴到"边录边传"。
- **大小上限**：由 appConfig 的 `upload_max_fileparts_default/premium` 决定。示例值是 4000/8000，乘以 512 KB 约合 2 GB / 4 GB（[api/config](https://core.telegram.org/api/config)）。实际以运行时下发的配置为准。
- **下载**：`upload.getFile(offset, limit)` 按 4 KB 对齐，一次请求不能跨越 1 MB 边界。这天然支持按范围读，可以边下边放。
- 服务端可能返回 `upload.fileCdnRedirect`，让客户端改从 CDN 下载（[cdn](https://core.telegram.org/cdn)）。
- `file_reference` 会过期，过期后要回到文件来源重新获取（[file-references](https://core.telegram.org/api/file-references)）。

**WhatsApp Cloud API**（[media](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media)）

- **上传**：`POST /PHONE_NUMBER_ID/media`，返回 `{id}`。也可以发送时直接给 `link`，官方不推荐（[send-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)）。
- **media id 有效期**：自己上传得到的 id 有效 **30 天**；webhook 里给的 id 有效 **7 天**。
- **下载**：先 `GET /MEDIA_ID`，返回 `{url, mime_type, sha256, file_size}`。**url 5 分钟就过期**，下载时要带 Bearer token。
- **支持格式与大小上限**：

| 类型 | 格式 | 上限 |
|---|---|---|
| audio | aac、amr、mp3、m4a、ogg（ogg 只支持 OPUS 编码、单声道） | 16 MB |
| document | txt、xls/xlsx、doc/docx、ppt/pptx、pdf | 100 MB |
| image | jpeg、png | 5 MB |
| sticker | webp | 动态 500 KB，静态 100 KB |
| video | 3gp、mp4（必须 H.264 视频 + AAC 音频） | 16 MB |
| 入站媒体 | — | 100 MB |

- **语音**：在 audio 消息里加 `"voice": true`，必须是 OGG/OPUS 格式；≤512 KB 才会显示播放按钮。文档里**没有 duration 和 waveform 字段**（[audio-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages)、[audio webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/audio)）。
- **caption**：只有 image、video、document 有，≤1024；document 另有 `filename` 字段（[image-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/image-messages)、[document-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/document-messages)）。

### 1.5 按钮与回调：审批卡片的直接参照

**Telegram**

- **InlineKeyboardMarkup**：按钮排成二维数组（[#inlinekeyboardmarkup](https://core.telegram.org/bots/api#inlinekeyboardmarkup)）。
- **InlineKeyboardButton**：除 `text` 外，必须且只能设一个动作字段（[#inlinekeyboardbutton](https://core.telegram.org/bots/api#inlinekeyboardbutton)）：
  - 可选动作有 url、**`callback_data`（1–64 bytes）**、web_app、login_url、switch_inline_query*、copy_text、pay，以及 10.3 新增的 `disabled`；
  - 按钮可选 `style`："danger"（红）、"success"（绿）、"primary"（蓝）。
- **CallbackQuery**：字段为 `{id, from, message, data, chat_instance}`。**客户端会一直显示进度条，直到 bot 调用 `answerCallbackQuery`**（[#callbackquery](https://core.telegram.org/bots/api#callbackquery)）。
- **answerCallbackQuery**：参数有 `text`（0–200 字符）、`show_alert`、`url`、`cache_time`（[answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery)）。
- **做出决定后原地更新按钮**：用 `editMessageReplyMarkup` 替换或禁用按钮（[editMessageReplyMarkup](https://core.telegram.org/bots/api#editmessagereplymarkup)）。官方建议改键盘，不要另发新消息（[bots/features#inline-keyboards](https://core.telegram.org/bots/features#inline-keyboards)）。
- **ForceReply**：弹出回复框，placeholder 1–64 字符（[#forcereply](https://core.telegram.org/bots/api#forcereply)），适合用在"自由文本回答"类的提问卡。

**WhatsApp**

- **`interactive` 的类型**有：button、list、product、product_list、catalog_message、call_permission_request、flow，另外还有 cta_url（[message-api](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)、[cta-url](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-cta-url-messages)）。
- **Reply buttons**：最多 3 个；id ≤256，title ≤20；body ≤1024（[reply-buttons](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages)）。
- **List**：最多 10 个 section，总共最多 10 行；行 title ≤24，description ≤72（[list-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages)）。
- **回调方式**：用户点击后，会进来一条 `type:"interactive"` 的入站消息，内容是 `button_reply{id,title}` 或 `list_reply`，`context.id` 指向原卡片（[interactive webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/interactive)）。**没有 answer/ack 机制，原卡片也不会变。**

**【判断】两家的差别与对 ergo 的取舍**

- Telegram 是"带外回调 + 原地改卡片"；WhatsApp 是"带内回复消息，卡片不动"。
- ergo 两者都要：
  - 卡片状态原地更新，用户一眼能看出"已批准"；
  - 同时把决定记成一条可审计的事件，用 `replyTo` 指回卡片。
- `callback_data` 只有 64 字节，说明按钮上只该放短 key，完整上下文存在服务端。ergo 的 `actionId` 也应该这样做。

### 1.6 WhatsApp 消息类型补充

- **请求的通用结构**：`{messaging_product, recipient_type, to, type, <type>:{…}, context?}`。`type` 可以是 text、image、audio、video、document、sticker、location、contacts、interactive、reaction、template 等（[send-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)）。
- **text**：
  - body ≤4096，`preview_url:true` 时只给第一个 URL 生成预览（[text-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages)）；
  - 格式直接写在 body 里（"Emojis and markdown are supported"），没有 entity offset 模型；
  - 具体支持哪些语法【未核实】。
- **reaction**：
  - 格式为 `{message_id, emoji}`；目标消息超过 30 天或已被删除时会失败（[reaction-messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/reaction-messages)）；
  - 用户撤销反应时，webhook 里不带 emoji 字段（[reaction webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/reaction)）；
  - reaction 只会回 `sent` 状态。
- **回复**：用 `context.message_id`（[contextual-replies](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/contextual-replies)）。
- **转发**：入站消息只带 `context.forwarded` / `frequently_forwarded`，没有原作者信息（[text webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text)）。
- **编辑与撤回**：
  - 入站有 `edit` 事件（用户 15 分钟内可编辑）和 `revoke` 事件（2 天内可撤回），但都只对 Coexistence 用户开放，而且 edit 目前 "temporarily unsupported"（[edit](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/edit)、[revoke](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/revoke)）；
  - 商家编辑或撤回自己已发出的消息：没找到相关文档【未核实】。
- 相册 / group id：在已读过的文档里没看到【未核实】。

### 1.7 Telegram 近期新增、和 agent 直接相关的能力（Bot API 10.x）

- **流式草稿 `sendMessageDraft`**：
  - 草稿是 "temporary 30-second preview"，要留在聊天里必须再调一次 `sendMessage`；
  - 同一个 `draft_id` 的多次更新之间有过渡动画，发空文本会显示 "Thinking…"；
  - 设 `can_stop` 后用户可以点停止，bot 会收到 `stopped_message_generation`（[sendMessageDraft](https://core.telegram.org/bots/api#sendmessagedraft)、[#messagegenerationstopped](https://core.telegram.org/bots/api#messagegenerationstopped)）。
  - 【判断】这正是"**流式草稿与持久消息分离**"的两段式模型，ergo 的 `part.delta`（不落盘）和 `part.end`（落盘）是同一个思路。
- **Rich Messages（10.1 起）**：用 blocks、html 或 markdown 三选一描述内容，可以包含表格、列表、公式、可折叠引用；有对应的流式版本 `sendRichMessageDraft`（[#inputrichmessage](https://core.telegram.org/bots/api#inputrichmessage)、[sendRichMessageDraft](https://core.telegram.org/bots/api#sendrichmessagedraft)）。
- **Checklist 消息**：带标题和任务列表（[#checklist](https://core.telegram.org/bots/api#checklist)），可以参照来做计划卡。
- **私聊 Topics**：把长对话拆成多个话题（[bots/features#topics-in-private-chats](https://core.telegram.org/bots/features#topics-in-private-chats)），可以对应 ergo 的"秘书主会话 + 项目频道"。

### 1.8 提炼：两家共有的数据模型

"ergo 取法"一列是【判断】，其余两列来自上文的文档。

| 概念 | Telegram | WhatsApp | ergo 取法 |
|---|---|---|---|
| 消息 id | `message_id`，只在 chat 内唯一；MTProto 发送时带 `random_id` 防重发（[sendMessage](https://core.telegram.org/method/messages.sendMessage)） | 字符串 `wamid` | 由客户端生成 ULID 作为幂等键，服务端提交后再分配 `seq` |
| 会话 | `chat.id` + `message_thread_id` | `wa_id` / group | `conversationId`（秘书主会话 / 项目频道） |
| 发送者 | `from` / `sender_chat` | `from` + `contacts[].profile` | `author{kind, agentId, role}` |
| 消息类型 | 看哪个可选字段有值 | 显式 `type` | **显式判别联合**（part 的 `type`） |
| 文本格式 | text + entities（UTF-16 offset） | body 里写 markdown | Markdown 文本（agent 输出本来就是 markdown）；需要精确引用时用 UTF-16 offset，和 JS 字符串一致 |
| 媒体引用 | file_id / file_unique_id、mime、size、duration、w/h、thumb；MTProto 有 waveform、stripped thumb | media id（30 天 / 7 天有效）+ 5 分钟 url + sha256 | `MediaRef{hash=sha256, mime, bytes, w, h, durationMs, thumb, placeholder}` |
| caption | 有，≤1024 | image / video / document 有 | part 上的 `caption` |
| 相册 | N 条消息共享 `media_group_id` / `grouped_id` | 未见 | **一条消息放多个媒体 part**（见 §6.1） |
| 回复 / 引用 | reply_parameters + TextQuote | context.message_id | `replyTo{messageId, partId?, quote?}` |
| 转发 | forward_origin | forwarded 标志 | `forwardedFrom`（项目频道 → 主会话） |
| 编辑 | edit_date + edited_message 事件 | edit webhook（受限） | `editedAt` + `message.updated` 事件 |
| 删除 | deleteMessage（48 小时内）；bot 收不到删除事件 | revoke webhook（受限） | `deletedAt` 墓碑 |
| 反应 | ReactionType，按差量下发 | reaction{emoji}，emoji 缺失表示撤销 | `reactions[]` + `reaction` 差量事件 |
| 投递 / 已读 | bot 拿不到；用户侧是水位线 | sent / delivered / read / failed / played；标已读连带之前的消息 | 消息 `status`；用户已读用会话水位线 `read{upToSeq}`；语音单独记 `playedAt` |
| 按钮 | InlineKeyboard，64B data，style，disabled | button ≤3 / list ≤10 / cta / flow | `card.actions[{id, label, style}]` |
| 回调 | CallbackQuery → answer → 改卡片 | 入站 button_reply + context.id | `action` → `ack` → `part.update`，再记一条审计事件 |
| 正在输入 / 流式 | sendChatAction ≤5 秒；sendMessageDraft | typing_indicator ≤25 秒 | `typing` / `recording` 事件；`part.delta` 流式 |

## 2. 语音消息 UX 与浏览器录音实现

> 部分来源说明：WhatsApp FAQ 页面靠 JS 渲染，WebFetch 抓不到全文。下表中标"搜索摘要"的条目是从搜索引擎给出的官方页面摘要里读到的，不是直接读的原页面。

### 2.1 WhatsApp / Telegram 的语音消息交互

| 交互模式 | WhatsApp | Telegram |
|---|---|---|
| 按住录音、松手发送 | 按住麦克风说话，松手即发送（[FAQ，搜索摘要](https://faq.whatsapp.com/657157755756612)） | "tap and hold the microphone icon… Once released… sent"（[TG](https://core.telegram.org/blackberry/chat-voice)） |
| 左滑取消 | "slide left to cancel"（同上） | "Sliding to the left while recording cancels"（同上） |
| 上滑锁定（解放双手） | "swipe up for hands-free recording"（同上） | 上滑锁定后可以暂停、设成 view-once、裁剪（[TG blog 2024-01](https://telegram.org/blog/new-saved-messages-and-9-more)） |
| 录音中暂停 / 继续 | 2022-03-30 上线（[WA blog](https://blog.whatsapp.com/making-voice-messages-better)） | 2024-01-31 上线（同上 TG blog） |
| 发送前试听 | 有（WA blog 同上） | 2016 年的 Raise to Speak 就有"Preview before sending"（[TG blog](https://telegram.org/blog/voice-2-secret-3)） |
| 裁剪起止点 | 【未核实】 | 2025-06-03 上线（[TG blog](https://telegram.org/blog/direct-to-channel-trim-voice-and-more)） |
| 波形 | 2022 年上线 Waveform Visualization（WA blog 同上） | 2016 年 Voice 2.0 引入，协议里存的是 5-bit 打包值（[documentAttributeAudio](https://core.telegram.org/constructor/documentAttributeAudio)） |
| 倍速 | 1.5x / 2x（[FAQ，搜索摘要](https://faq.whatsapp.com/1165411581043811)） | 0.5x / 1.5x / 2x（[TG blog](https://telegram.org/blog/video-1000)） |
| 连续播放 / 后台播放 | 多条语音按顺序自动连播；切换聊天后继续播放（FAQ 同上） | 切到别的聊天后仍在后台播放（[TG blog](https://telegram.org/blog/voice-2-secret-3)） |
| 记住播放进度 | Remember Playback（WA blog 同上） | 【未核实】 |
| 贴耳收听 | 【未核实】 | 打开聊天后把手机贴到耳边即可收听或录音（[TG blog](https://telegram.org/blog/voice-2-secret-3)） |
| "已听"标记 | 灰色麦克风 = 还没完整播放，蓝色 = 已播放；"已读"和"已播放"是两个不同的状态（[FAQ，搜索摘要](https://faq.whatsapp.com/en/android/28000015)） | `messages.readMessageContents` 会通知发送方"对方已收听"（[method](https://core.telegram.org/method/messages.readMessageContents)） |
| 转写 | 在本机生成："Transcripts are generated on your device"（2024-11，[WA blog](https://blog.whatsapp.com/introducing-voice-message-transcripts)） | Premium 功能。API 先返回 `pending`，之后用 `updateTranscribedAudio` 逐步推送转写文本（[api/transcribe](https://core.telegram.org/api/transcribe)） |

**Telegram 波形的具体格式**：Telegram Android 客户端源码里：

- 采样点数固定为 `resultSamples = 100`；
- 每个点按 `MIN(31, abs(sample)*31/peak)` 归一化到 0–31；
- 按 5 bit 打包，100 个点共 63 字节（[audio.c](https://raw.githubusercontent.com/DrKLO/Telegram/master/TMessagesProj/jni/audio.c)）。

TDLib 对语音文件的要求是："Opus codec… OGG container with a single audio channel, or… MP3 or M4A"（[TDLib inputMessageVoiceNote](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1input_message_voice_note.html)）。

**【建议】ergo 的语音交互**

- 移动端：
  - 按住录音、左滑取消、上滑锁定；
  - 锁定后可以暂停 / 继续、试听、发送；
  - 裁剪功能后置。
- 桌面端：点击开始 / 停止，另配快捷键。
- 播放：
  - 倍速按 1x → 1.5x → 2x 循环切换，并记住全局偏好；
  - 连续语音自动连播；
  - 显示"已听"标记；
  - 提供"转写"按钮。在 ergo 里转写是默认自动做的，这个按钮用来展开或收起转写文本。

### 2.2 MediaRecorder 支持的编码（截至 2026）

| 平台 | 可录制的音频格式 | 默认格式 | 依据 |
|---|---|---|---|
| Chrome / Chromium（桌面、Android） | `audio/webm` 和 `audio/x-matroska`：opus、pcm<br>`audio/mp4`：opus、`mp4a.40.2`（AAC，需要 proprietary codecs 编译开关，且平台有 AAC 编码器）<br>**不支持 `audio/ogg`** | webm/opus | [Chromium media_recorder_handler.cc](https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/modules/mediarecorder/media_recorder_handler.cc) |
| Chrome 126+（2024-06） | 新增 MP4 容器的 muxing | — | [Chrome 126 release notes](https://developer.chrome.com/release-notes/126) |
| Android System WebView | 基于 Chromium，【推断】与同版本 Chrome 一致；Android 上能否录 AAC【未核实】 | — | 同上 |
| Firefox | 只支持 `audio/webm`、`audio/ogg`、`video/webm`，音频编码只有 opus | 纯音频时为 `audio/ogg;codecs=opus` | [MediaRecorder.cpp](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/media/MediaRecorder.cpp)；MP4 支持的 [bug 1631143](https://bugzilla.mozilla.org/show_bug.cgi?id=1631143) 仍处于 NEW 状态 |
| Safari 14.1 / iOS 14.5+ | 支持 MediaRecorder | `audio/mp4`（AAC） | [WebKit blog](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/)、[WebKit 源码](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/mediarecorder/MediaRecorderPrivateEncoder.cpp) |
| Safari 18.4（2025-03，含 iOS） | 新增 "WebM files using the Opus audio codec"、fragmented MP4、ALAC/PCM | — | [WebKit blog 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/) |
| **HarmonyOS ArkWeb** | 官方给出的内核版本：HarmonyOS 4.1–5.1 是 M114；6.0 默认 M132（可选 M114）；6.1 是 M132；7.0 默认 M144。**官方没有写明 MediaRecorder 支持哪些编码**【未核实】。【推断】能录 webm/opus；能否录 AAC 取决于华为 fork 的编译开关 | — | [ArkWeb 简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-component-overview)、[ArkWebEngineVersion](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-webview-e) |

**录音格式的探测策略**

按优先级试，选第一个支持的：

```js
const CANDIDATES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4;codecs=opus", "audio/mp4"];
const mimeType = CANDIDATES.find(t => MediaRecorder.isTypeSupported?.(t)) ?? "";
const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
// 以 rec.mimeType 为准，上传时带上
```

使用时注意：

- `isTypeSupported` 返回 true，也不保证录音一定成功（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static)）。
- 规范 Editor's Draft（2026-03-16）已经把 `isTypeSupported` 标成 "deprecated; it exists for legacy compatibility reasons only"（[mediacapture-record](https://w3c.github.io/mediacapture-record/)）。所以录音开始后要以 `rec.mimeType` 为准，并处理 `error` 事件。

**时长缺失、无法 seek 的问题**

- Chromium 录出的 WebM 是 live 模式，不带 Cues（[issue 40482588 "consider producing seekable WebM files"](https://issues.chromium.org/issues/40482588)，当前状态【未核实】）。
- Chrome 和 Safari 录出的 fMP4，其 moov atom 里也没有 duration。这一点来自厂商博客的实测（[Addpipe](https://blog.addpipe.com/duration-in-mp4-files-produced-by-chrome-safari/)），不是一手来源。
- **结论**：daemon 统一用 ffmpeg 重新封装或转码。时长由服务端计算后写进元数据，不能依赖浏览器产出的文件头。

**其他采集方案**

- **AudioWorklet 直接取 PCM**：低延迟、要求 secure context（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)）。适合以后做边说边转写，可以直接送 16k PCM。
- **WebCodecs `AudioEncoder`**：还不是 Baseline（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder)）。
- **opus-recorder（WASM）**：作者已声明 "PROJECT NO LONGER SUPPORTED"（[GitHub](https://github.com/chris-rudmin/opus-recorder)），**不推荐**。

### 2.3 WebView 内的麦克风权限与 secure context

**通用前提**：`getUserMedia` 只能在 secure context 里用（https、`file:///`、localhost）；在非安全上下文中，"navigator.mediaDevices is undefined"（[MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)）。**用 `http://192.168.x.x:port` 打开 UI 时，麦克风直接不可用。** 这是 ergo 部署形态里必须先解决的问题。

**Android WebView**

1. **Manifest**：
   - 声明 `RECORD_AUDIO`。它是 dangerous 级权限，必须在运行时申请（[Manifest.permission](https://developer.android.com/reference/android/Manifest.permission)）。
   - 建议同时声明 `MODIFY_AUDIO_SETTINGS`。Chromium 源码注释写明 "Both are required for full functionality"（[AudioManagerAndroid.java](https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/android/java/src/org/chromium/media/AudioManagerAndroid.java)）。
2. **`WebChromeClient.onPermissionRequest`**：
   - 不重写这个方法，权限就会被拒绝（[WebChromeClient](https://developer.android.com/reference/android/webkit/WebChromeClient)）。
   - 文档明确警告：`grant(getResources())` 是错误写法 "This is wrong!!!"，应只授予 `RESOURCE_AUDIO_CAPTURE`（[PermissionRequest](https://developer.android.com/reference/android/webkit/PermissionRequest)）。
3. **文件选择**：必须实现 `onShowFileChooser`，否则 WebView 默认取消所有文件请求（同上 WebChromeClient 页）。
4. **加载打包进 App 的 UI**：用 `WebViewAssetLoader`，通过 `https://appassets.androidplatform.net/assets/...` 加载，这样页面就是 https 源（[WebViewAssetLoader](https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader)）。
5. **新问题：页面是 https，daemon 却在 http 局域网地址上，构成 mixed content**：
   - API 21 起默认 `MIXED_CONTENT_NEVER_ALLOW`，官方 "strongly discouraged" 改成允许（[WebSettings](https://developer.android.com/reference/android/webkit/WebSettings)）；
   - API 28 起默认禁止 cleartext 流量（[application element](https://developer.android.com/guide/topics/manifest/application-element)）；
   - Chrome 142 推出 Local Network Access 权限：公网页面访问私网地址时需要用户授权（[Chrome blog](https://developer.chrome.com/blog/local-network-access)）。WebView 是否同样适用【未核实】。

**HarmonyOS ArkWeb**（[《在Web中打开摄像头和麦克风》](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-rtc)）

1. 在 `module.json5` 中声明 `ohos.permission.MICROPHONE`，并调用 `requestPermissionsFromUser` 向用户申请。
2. 实现 `Web().onPermissionRequest(e => e.request.grant(e.request.getAccessibleResource()))`。
   - 官方示例是有什么就授权什么。
   - 【建议】改成只放行 `TYPE_AUDIO_CAPTURE`，并校验 `getOrigin()`（[PermissionRequest](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web-permissionrequest)）。
3. 官方示例用 `$rawfile('index.html')` 加载页面后调用 `getUserMedia`。【推断】rawfile 页面可以使用麦克风，尚未在真机上验证。
4. 自定义 scheme 设置 `isSecure`（API 12+）后，可以按 https 的安全规则处理（[WebCustomScheme](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-webview-i)）；请求可以用 `setWebSchemeHandler` 拦截（[web-scheme-handler](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-scheme-handler)）。
5. 混合内容 `mixedMode` 默认是 `None`，即禁止（[Web attributes](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web-attributes)）。

**【判断】对 ergo 部署的影响**

- 浏览器直接访问 daemon 时，daemon 必须提供 HTTPS，或者只能通过 localhost 访问。
- App 外壳内：
  - UI 打包进 App，用 https 源（Android 用 AssetLoader，鸿蒙用 rawfile 或 isSecure scheme）；
  - daemon 的 API 也走 HTTPS（自签 CA，或带证书的域名 / 隧道）；
  - 不要靠放开 mixed content 或 cleartext 来绕过。
- 另一条路是**原生录音再通过 JS bridge 传给网页**（Android MediaRecorder / 鸿蒙 AVRecorder），这样可以完全绕开 WebView 的麦克风权限链。这条路【未核实】，需要单独调研。

### 2.4 分块上传

- **`start(timeslice)` 的语义**：每隔约 timeslice 毫秒产出一个 Blob。规范原文是："**the individual Blobs need not be playable, but the combination of all the Blobs… MUST be playable**"（[mediacapture-record](https://w3c.github.io/mediacapture-record/)）。
  - 容器头只在第一块里，后续块不能单独解码。服务端只能按顺序追加。
  - `requestData()` 可以立即切出一块（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)）。
- **两种上传方式**：
  - **录完再传**：最简单，适合 60 秒以内的短语音。
  - **边录边传**：用 `start(1000)`，每块通过 WebSocket 或 HTTP append 推给 daemon。松手时基本已经传完，弱网下也不容易丢。
- **tus 协议 1.0.0**（[spec](https://tus.io/protocols/resumable-upload)）：
  - 用 HEAD 查询 `Upload-Offset`，用 PATCH 续传；
  - `Upload-Defer-Length: 1` 支持总长度未知的上传，正好适合边录边传；
  - `Upload-Checksum` 做校验，不匹配时返回 460；
  - Node 端用 `@tus/server` + `@tus/file-store`，要求 Node ≥20.19（[tus-node-server](https://github.com/tus/tus-node-server)）；
  - 浏览器端用 tus-js-client，配置 `uploadLengthDeferred`（[docs](https://github.com/tus/tus-js-client/blob/main/docs/api.md)）。
- **【建议】**单用户场景下，语音先用自定义的简单 append API，以后需要时再换 tus：
  - 上传分块：`PUT /upload/:id/chunk?offset=N`，带 seq 和 sha256；服务端校验 offset 连续，重复块幂等丢弃；
  - 提交：`POST /upload/:id/commit {mime}`；
  - 离线时把分块存进 IndexedDB 兜底。
  - 视频这类大文件可以直接用 tus。

### 2.5 波形与倍速

| 环节 | 做法 | 来源 |
|---|---|---|
| 录音中的实时电平 | `AnalyserNode.getByteTimeDomainData` | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode) |
| 前端离线计算波形 | `decodeAudioData` 只能处理完整文件（"only works on complete file data, not fragments"），解码后分桶取最大绝对值 | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData) |
| 服务端计算波形 | BBC audiowaveform，输入支持 MP3/WAV/FLAC/Ogg/Opus，输出 JSON；也可以让 ffmpeg 输出 PCM 后自己分桶 | [audiowaveform](https://github.com/bbc/audiowaveform) |
| 渲染 | wavesurfer.js v8（BSD-3），可以直接用预先算好的 `peaks` + `duration` 渲染，另有 Record 插件 | [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) |
| 倍速 | `HTMLMediaElement.playbackRate`；`preservesPitch` 默认 true，变速时保持音调，2023-12 起全平台可用 | [playbackRate](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate)、[preservesPitch](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preservesPitch) |

【建议】波形由 daemon 在转码时生成，取 **100 个 0–31 的值**（与 Telegram 一致），存进消息的元数据。前端只负责画，不解码音频。

### 2.6 本地 Whisper 对输入的要求

- **whisper.cpp**（[GitHub](https://github.com/ggml-org/whisper.cpp)）：
  - CLI 只接受 16-bit WAV，转换命令：`ffmpeg -i in -ar 16000 -ac 1 -c:a pcm_s16le out.wav`。
  - `whisper-server` 提供 OpenAI 兼容的 HTTP 接口，带 `--convert`（需要 ffmpeg）和 `--vad` 选项（[server README](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md)）。
  - `whisper-stream` 只能采本机 SDL2 麦克风，靠 `--step/--length` 滑窗（[stream README](https://github.com/ggml-org/whisper.cpp/blob/master/examples/stream/README.md)）。远端传来的音频流要在 daemon 里自己实现滑窗。
- **faster-whisper**（[GitHub](https://github.com/SYSTRAN/faster-whisper)）：
  - 用 PyAV 解码，不需要另装 ffmpeg，可以直接读 webm、ogg、m4a；
  - 内置 Silero VAD 和 `word_timestamps`；
  - `segments` 是生成器，可以边算边推部分结果。
- **播放格式转码**：libopus 设 `application=voip` 对语音更好（[ffmpeg codecs](https://ffmpeg.org/ffmpeg-codecs.html)）。

**【建议】daemon 的处理管线**

1. 保存原始文件，写入内容寻址存储。
2. 用 ffmpeg 转出 16k mono WAV，交给 Whisper 转写，转写完删除这个临时 WAV。
3. 用 ffmpeg 转出播放格式：主力是 Opus（WebM 或 Ogg，24–32 kbps，`application=voip`）；如果要支持 Safari 浏览器，再多转一份 AAC m4a（`+faststart`）。
4. 计算 100 个点的波形和准确的 `durationMs`。
5. 把转写状态（pending → partial → done/failed）以 `part.update` 事件推给前端。这和 Telegram 的 `pending` → `updateTranscribedAudio` 模式一样。

## 3. React 聊天 UI 构件与 parts 模型

> 证据来源说明：
> - 类型定义和运行行为，读的是 npm tarball 里的源码，版本为 `ai@7.0.128`、`@assistant-ui/core@0.3.24` / `@assistant-ui/react@0.15.25`、`stream-chat@9.54.0` / `stream-chat-react@14.12.2`、`@chatui/core@3.8.0`、`@chatscope/chat-ui-kit-react@2.1.1`、`pi-web-ui@0.75.3`，并对照了官方文档和 GitHub main。
> - **体积数字是调研时用 esbuild 本地实测的**：minify、React 外置、不含 CSS、gzip 后的大小。不是官方数字，只能用来比较各库的相对量级。

### 3.1 Vercel AI SDK：`UIMessage` 的 parts 模型

- **版本**：
  - `ai` 最新版是 7.0.128（2026-10-05）；7.0.0 发布于 2026-06-25。
  - v5、v6、v7 三条线同时在维护，大约半年出一个大版本（[npm](https://registry.npmjs.org/ai)）。
  - 许可证 Apache-2.0。v7 只支持 ESM，Node 要求 ≥22（[migration 7.0](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0)）。
- **`UIMessage` 结构**（[ui-messages.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/ui-messages.ts)、[reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message)）：
  - 外层是 `{id, role, metadata?, parts[]}`。**没有 createdAt 和 sender**，这类信息都要放进 `metadata`。
  - parts 有以下几种：
    - `text{text, state: streaming|done}`、`reasoning{text, state}`。
    - `tool-${name}` / `dynamic-tool`，字段为 `{toolCallId, state, input, output, errorText, approval}`。
      - state 依次是 `input-streaming → input-available → (approval-requested → approval-responded) → output-available | output-error | output-denied`。
      - 审批相关的状态是 v6 加的（[migration 6.0](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)）。
    - `source-url` / `source-document`。
    - `file{mediaType, url, filename?}`。
    - v7 新增的 `reasoning-file`、`custom`。
    - `data-${name}{id?, data}`。
    - `step-start`。
- **流协议**（[stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)、[ui-message-chunks.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts)）：
  - 走 SSE，每条是 `data: {JSON}`。自建后端要加 `x-vercel-ai-ui-message-stream: v1` 头，并以 `[DONE]` 结束。
  - 文档明确支持用其他语言实现后端，还给了 FastAPI 示例。
  - chunk 分几类：
    - 消息级：`start` / `finish` / `abort` / `error` / `message-metadata`。
    - 文本和推理：`text-start/delta/end`、`reasoning-*`。
    - 工具：`tool-input-start/delta/available`、`tool-approval-request`、`tool-output-available/error/denied`。
    - 其他：`file`、`data-*`、`start-step/finish-step`。
- **data part 的两条规则**（[streaming data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data)）：
  - **同 type、同 `id` 的 data part 再次写入时，会原地替换旧数据**，正好用来做进度卡。
  - 标了 `transient:true` 的 data part 只交给 `onData` 回调，不会进入 `parts`。
- **一个坑**：流里的 `file` chunk 只带 `url`、`mediaType`、`providerMetadata`，连 `filename` 都会丢（[process-ui-message-stream.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/process-ui-message-stream.ts)）。富媒体元数据要改用 `data-*` 承载。
- **人在回路（HITL）**（[tool usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)）：
  - 有 `addToolOutput`、`addToolApprovalResponse`、`sendAutomaticallyWhen` 三个入口。
  - v7 废弃了 `needsApproval`，改用 `toolApproval`。
- **传输层**（[chat-transport.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/chat-transport.ts)、[transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport)）：
  - `ChatTransport` 只有两个方法：`sendMessages(...) → ReadableStream<UIMessageChunk>` 和 `reconnectToStream`。文档点名可以用来接 WebSocket。
  - 服务端不需要装 AI SDK，只要输出符合协议的流就行。
  - `readUIMessageStream` 可以脱离 `useChat` 单独使用，把 chunk 流还原成 UIMessage（[reading streams](https://ai-sdk.dev/docs/ai-sdk-ui/reading-ui-message-streams)）。
- **【判断】局限**：`useChat` 的模型是"一次请求对应一条流"，**没有服务端主动推送新消息的通道**。而二狗需要主动提醒、PM 汇报、多端同步，这部分得放进自己的 store。
- **React 19、体积、样式**：
  - `@ai-sdk/react` 的 peer 依赖写的是 `^18 || ~19.0.1 || ~19.1.2 || ^19.2.1`，刻意排除了几个 19.x 早期版本（[npm](https://registry.npmjs.org/@ai-sdk/react/latest)）。原因【未核实】，推测是安全补丁的下限。
  - 不带样式（headless）。
  - 实测体积：`useChat` 约 51 KB；只用 `readUIMessageStream` 约 50 KB；只 `import type` 时为 0。

### 3.2 assistant-ui

- **版本与许可**：`@assistant-ui/react` 0.15.25（2026-10-06），还没到 1.0；0.15.0 之后已经发了 25 个补丁版（[npm](https://registry.npmjs.org/@assistant-ui/react)）。MIT 许可（[GitHub](https://github.com/assistant-ui/assistant-ui)）。
- **依赖与体积**：依赖 radix-ui、zustand、zod@4、assistant-stream、assistant-cloud。只用 primitives + ExternalStore 的实测体积约 98 KB。
- **消息模型**（[message.ts](https://github.com/assistant-ui/assistant-ui/blob/main/packages/core/src/types/message.ts)）：
  - ThreadMessage 结构：`{id, createdAt, role, content[], status, attachments, metadata{custom, steps, timing, modality:"voice"}}`。
  - content 支持的类型：text、reasoning、source、`image`、`file{data, mimeType, filename}`、`audio`、`data{name, data}`、`tool-call{args, result, interrupt, approval}`、`generative-ui`。
  - 其中 `audio` 标记为 `Unstable_`，而且只能用在 user 消息里。
  - 引用回复放在 `metadata.custom.quote`（[useMessageQuote](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react/src/hooks/useMessageQuote.ts)）。
- **运行时**（[custom runtimes](https://www.assistant-ui.com/docs/runtimes/custom/overview)）：
  - 可选 `LocalRuntime`、`ExternalStoreRuntime`、`DataStream`、`AssistantTransport` 四种。
  - **ExternalStoreRuntime 的状态由使用方自己持有**：传入 `messages` 和 `convertMessage`，以及 `onNew`、`onAddToolResult`、`onRespondToToolApproval` 等回调。可以接任何 WS/SSE 后端（[external store](https://www.assistant-ui.com/docs/runtimes/custom/external-store)）。
- **附件、工具 UI、语音**：
  - 附件适配器的接口是 `{accept, add, send, remove}`（[attachments](https://www.assistant-ui.com/docs/guides/attachments)）。
  - 工具 UI 现在用 `defineToolkit`；旧的 `makeAssistantToolUI` 已标 deprecated（[tool ui](https://www.assistant-ui.com/docs/tools/tool-ui)）。
  - 语音只有两块：`SpeechSynthesisAdapter.speak(text)` 用来朗读一条消息，另有听写和 realtime 适配器（[speech](https://www.assistant-ui.com/docs/guides/speech)）。**"把语音当作附件消息"这一形态不存在。**
- **样式**：primitives 本身不带样式（[primitives](https://www.assistant-ui.com/docs/primitives)）。成品组件要通过 shadcn CLI 拷进项目，并依赖 Tailwind。

### 3.3 stream-chat-react（GetStream）

- **版本**：14.12.2（2026-10-05），维护活跃（[npm](https://registry.npmjs.org/stream-chat-react)）。
- **许可证是专有的**：前提是 "you are a current customer of Stream.io"，并且只能用于 "in-app messaging via Stream's API"（[LICENSE](https://github.com/GetStream/stream-chat-react/blob/master/LICENSE)）。
- **不能接自建后端**：组件建立在 `stream-chat` 客户端之上，连接、状态、API 都由这个客户端管理（[docs](https://getstream.io/chat/docs/sdk/react/)）。AI 的流式输出也要由后端调用 Stream 服务端 SDK 来驱动（[AI integrations](https://getstream.io/chat/docs/sdk/react/guides/ai-integrations/)）。
- **IM 功能最完整，适合当参考**：
  - Attachment 带 `waveform_data`、`duration`、`thumb_url`。
  - `voiceRecording` 播放器支持波形拖动和倍速（[voice recording](https://getstream.io/chat/docs/sdk/react/components/message-components/attachment/voice-recording/)）。
  - 还有 quoted_message、thread、reactions。
  - 实测体积约 521 KB。

### 3.4 阿里 ChatUI（`@chatui/core`）

- **版本与维护**：3.8.0（2026-05-26），MIT。GitHub 最后一次 push 是 2026-03-30，看起来像内部同步（[GitHub](https://github.com/alibaba/ChatUI)）。
- **消息模型**：`{_id, type, content: any, createdAt, user, position, status}`，按 `type` 分发、自己写渲染。**没有流式，也没有传输层。**
- **组件**：有 Card、FileCard、Video、Think、QuickReplies、Recorder。注意 `Recorder` 只是"按住说话"的界面，回调里只给 `duration`，不负责录音本身。
- **React 19 有硬伤**：Toast 用了 `ReactDOM.render` / `unmountComponentAtNode`，这两个 API 在 React 19 里已经移除（[React 19 upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)）。对应 issue 至今未关（[#180](https://github.com/alibaba/ChatUI/issues/180)）。
- **体积**：约 84 KB。

### 3.5 chatscope（`@chatscope/chat-ui-kit-react`）

- **维护**：2.1.1（2025-05-15）之后就没有再更新，那一版只是给 peer 依赖加上了 React 19（[PR #171](https://github.com/chatscope/chat-ui-kit-react/pull/171)）。
- **定位**：纯展示组件。消息模型是 `{message, sentTime, sender, direction, position, type: html|text|image|custom, payload}`，自定义内容用 `Message.CustomContent` 渲染。
- **XSS 隐患**：type 默认是 `"html"`，用 `dangerouslySetInnerHTML` 渲染且没有做清洗（依据：读 dist 源码）。
- **体积**：约 43 KB。

### 3.6 参考实现：OpenClaw Control UI（Lit）与 pi-web-ui

- **OpenClaw 的消息内容块**（[chat-types.ts](https://github.com/openclaw/openclaw/blob/main/ui/src/lib/chat/chat-types.ts)）：
  - 类型有 `text`、`tool_call`、`tool_result`、`thinking`、`image{sources[]}`、`attachment{url, kind, isVoiceNote, durationMs, playback: native|transcode, width, height}`、`attachment_error`、`omitted_media`、`canvas`。
  - 消息上还带 `replyPreview` / `replyTarget`、`sender`、`audioAsVoice`。
  - normalizer 会把 Anthropic 风格的 `audio{source}` 转成 attachment（[message-normalizer.ts](https://github.com/openclaw/openclaw/blob/main/ui/src/lib/chat/message-normalizer.ts)）。
  - 工具调用单独用 `ToolCard` 展示，状态有 running / succeeded / failed / blocked / skipped。
- **OpenClaw 的流式与发送**：
  - WebSocket 上的 `chat` 事件带 `state: status|delta|final|aborted|error`，同时携带 `runId`、`sessionKey`、`seq`。delta 里有 `deltaText`，`replace` 表示整段替换（[logs-chat.ts](https://github.com/openclaw/openclaw/blob/main/packages/gateway-protocol/src/schema/logs-chat.ts)）。
  - 客户端按 runId 维护一份基线来拼接增量，基线丢了就重连（[chat-stream-projection.ts](https://github.com/openclaw/openclaw/blob/main/packages/gateway-client/src/chat-stream-projection.ts)）。
  - `chat.send` 带 `idempotencyKey`、`replyToId`，以及 `attachments[{mimeType, fileName, content, durationMs, width, height}]`。
- **OpenClaw 最值得借鉴的架构经验**（[webchat.md](https://github.com/openclaw/openclaw/blob/main/docs/web/webchat.md)）：
  - 实时事件只负责"投递"。
  - `chat.history` 从持久化的 transcript 重建，是唯一的权威数据。
  - 客户端只合并一小段乐观更新的尾巴，等历史追上来就用权威数据替换掉。
- **OpenClaw 的渲染细节**：
  - Markdown 用 markdown-it + DOMPurify。
  - 流式输出中途会出现不完整的 Markdown，用 streamdown 项目的 `remend` 来修补（[markdown-streaming.ts](https://github.com/openclaw/openclaw/blob/main/ui/src/components/markdown-streaming.ts)）。
  - 有语音波形播放器、reactions、提问卡片（question card）。
  - 富输出用文本内指令表达，如 `[[audio_as_voice]]`、`[[reply_to:<id>]]`、`MEDIA:`（[rich-output-protocol](https://github.com/openclaw/openclaw/blob/main/docs/reference/rich-output-protocol.md)）。
- **pi-web-ui 0.75.3**（已停更，见 `03-openclaw-and-pi.md`）：
  - 用 Lit 直接渲染 pi-ai 的内容块：`text`、`thinking`、`image{data, mimeType}`、`toolCall`，另有单独的 `toolResult` 消息。
  - Attachment 只有 image 和 document 两种（document 带 `extractedText`），**没有音视频**。
  - 扩展靠 `registerMessageRenderer` 和 `registerToolRenderer`。
- **【判断】映射关系**：pi-ai 的流事件（`text_*`、`thinking_*`、`toolcall_*`、`done`、`error`）和 AI SDK 的 chunk 可以一一对应。所以 daemon 端把 pi 事件翻译成 AI SDK 形状的 chunk，代价很低。

### 3.7 对比与选型

| 维度 | AI SDK UIMessage | assistant-ui | stream-chat-react | ChatUI | chatscope |
|---|---|---|---|---|---|
| parts 模型 | 最完整：工具状态机、审批、data/file/source | 完整；audio 不稳定 | IM 模型：消息 + 附件 | `type + content:any` | html/text/image/custom |
| 自定义卡片 | `data-*` + id 可原地更新 | toolkit render、generative-ui | 自定义附件类型 | 自己写渲染 | CustomContent |
| 自建 WS/SSE | 可以（ChatTransport，或直接输出协议） | 可以（ExternalStore） | **不行**（绑定 Stream 云） | 可以（它没有传输层） | 可以（它没有传输层） |
| 语音 / 引用 / 表情 | 都要自己扩展 | 只有引用 | 都有，含波形 | 只有录音 UI | 无 |
| 样式依赖 / 实测体积 | 无样式 / 0–51 KB | Radix + shadcn + Tailwind / 约 98 KB | 自带主题 / 约 521 KB | 自带 CSS / 约 84 KB | 自带 CSS / 约 43 KB |
| React 19 | 可用 | 可用 | 可用 | **Toast 会坏** | 基本可用 |
| 维护状况 | 很活跃，半年一个大版本 | 很活跃，1.0 前 API 变化快 | 很活跃 | 一般 | 停更 17 个月 |
| 许可证 | Apache-2.0 | MIT | 专有 | MIT | MIT |
| 适合 ergo 吗 | **适合作数据模型和协议** | 可作备选 | 不适合 | 不适合 | 不适合 |

**【判断】结论**

- 偏 agent 的库（AI SDK、assistant-ui）有工具、审批、data part，但**都没有** messenger 能力：语音消息、反应、相册、已读。
- 偏 IM 的库（Stream）有 messenger 能力，但绑定自家云，许可证也是专有的。
- 两头都不完全覆盖 ergo 的需求，而前代项目本来就是手写 React 19 + CSS。所以：
  1. **前端继续手写 React 19 + 手写 CSS**。消息 store 自己掌握（zustand 或 `useSyncExternalStore`），主动推送、多端同步、断线补齐都在这一处处理。
  2. **数据模型和流协议向 AI SDK v7 的 UIMessage/chunk 看齐**，再加上 ergo 自己的超集（§6）。daemon 把 pi 事件翻译成这种形状。前端可以选用 `readUIMessageStream`（约 50 KB），也可以只 `import type`、自己写 reducer。**协议版本由 ergo 自己固定**，不跟着上游库升级。
  3. **照搬 OpenClaw 的三条做法**：
     - 实时增量和持久化历史分开，历史是唯一的权威；
     - 发送带 `idempotencyKey`，每个 run 内带 `seq`；
     - 流式 Markdown 用 `remend` 修补，再用 DOMPurify 清洗。
  4. **assistant-ui 只留作备选**：如果以后想要现成的输入框、滚动和附件 UI，可以用 ExternalStoreRuntime 把自己的 store 接上去。但它给不了语音、反应、相册，还会带进 Radix、Tailwind 和 1.0 之前频繁的 API 变化。现阶段不建议引入。

## 4. DeepSeek V4.1（Flash / Pro）：官方文档现状（2026-10-07 核对）

> 核对方式：直接抓取 api-docs.deepseek.com 页面原文（英文与中文两版），以及 pi 仓库 `main@ae92585`（2026-10-06）和 npm 上 `@earendil-works/pi-ai@1.0.4` 的发布包。

### 4.1 模型 ID、版本、上下文、输出长度

| 项 | `deepseek-flash` | `deepseek-v4-pro` | 来源 |
|---|---|---|---|
| 实际模型版本 | DeepSeek-V4.1-Flash | DeepSeek-V4-Pro-0813 | [pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| Base URL | OpenAI 格式 `https://api.deepseek.com`；Anthropic 格式 `https://api.deepseek.com/anthropic`；另支持 Responses API | 同左 | [pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| 上下文 | 1M | 1M | [pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| 最大输出 | 384K（393216） | 384K | [pricing](https://api-docs.deepseek.com/quick_start/pricing)、[API ref](https://api-docs.deepseek.com/api/create-chat-completion) |
| `max_tokens` 默认值 | 非思考 8K；思考 64K；`reasoning_effort=max` 时 128K | 同左 | [API ref](https://api-docs.deepseek.com/api/create-chat-completion) |
| 图像理解（Vision） | 支持 | **不支持** | [pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| JSON Output / Tool Calls / 对话前缀续写（Beta） | 支持 | 支持 | [pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| FIM（Beta） | 仅非思考模式 | 仅非思考模式 | [pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| 并发上限（账号级） | 2500 | 500 | [rate limit](https://api-docs.deepseek.com/quick_start/rate_limit) |

版本沿革与要点：

- **V4.1 Flash 于 2026-09-10 发布**。官方称它是"新架构家族里最小的模型"，原生支持多模态视觉理解。模型是 552B 参数的 MoE，采用 Causal Encoder–Decoder 结构，输入侧激活 8B、输出侧激活 16B。KV cache 只需上一代的 1/4 HBM、1/8 SSD（[news260910](https://api-docs.deepseek.com/news/news260910)、[change log](https://api-docs.deepseek.com/updates)）。
- 旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，但对应模型已经下线，请求由 V4.1 Flash 处理，并按 Flash 价格计费（[pricing 脚注 1](https://api-docs.deepseek.com/quick_start/pricing)）。
- `deepseek-chat` / `deepseek-reasoner` 在 2026-04-24 公告"三个月后（2026-07-24）停用"（[change log](https://api-docs.deepseek.com/updates)）。**ergo 不应再使用这两个名字。**
- **"V4.1 Pro" 目前还没发布。**
  - 发布稿原本写的是：北京时间 2026-09-14 12:00 起，到"未来 V4.1 Pro 上线之前"，`deepseek-v4-pro` 的请求一律路由到 V4.1 Flash，按 Flash 计费（[中文 news260910](https://api-docs.deepseek.com/zh-cn/news/news260910)）。
  - 但 change log 同一条目后来又补了一句："为响应广大用户的需求，我们决定在 2026 年 9 月 14 日之后继续提供 DeepSeek V4 Pro 的 API 调用服务，计费方式保持不变"（[中文 updates](https://api-docs.deepseek.com/zh-cn/updates)）。
  - 价格页现在仍把 `deepseek-v4-pro` 标为 DeepSeek-V4-Pro-0813。
  - 结论：截至 2026-10-07，官方文档里**没有 V4.1 Pro 的模型 ID、价格和能力表**。V4.1 Pro 的一切参数都标【未发布/未核实】。
  - 【判断】ergo 的模型配置要做成"角色 → 模型 ID"的映射，等 V4.1 Pro 上线后改一行配置即可。
  - 【判断】按官方说法，V4.1 Flash 在多项 benchmark 上已经超过 V4 Pro（[news260910](https://api-docs.deepseek.com/news/news260910)）。现阶段换成 `deepseek-v4-pro` 不一定更强，而且更贵、还没有视觉能力。

### 4.2 Tool / function calling

- 思考与非思考两种模式都支持 tool calls（[tool calls guide](https://api-docs.deepseek.com/guides/tool_calls)）。
- **strict 模式（Beta）**：需要 `base_url=https://api.deepseek.com/beta`，并且每个 function 都设 `strict: true`。服务端会校验 JSON Schema，规则如下（[tool calls guide](https://api-docs.deepseek.com/guides/tool_calls)）：
  - object 的所有属性必须列为 required，且 `additionalProperties: false`；
  - 支持 enum、anyOf、`$defs`/`$ref`（可递归）；
  - 不支持 `maxLength`、`maxItems` 等约束。
- `tool_choice`：默认是 none（无 tools 时）或 auto（有 tools 时）。**思考模式下不支持 `required` 和指定具体工具**，会返回 400（[API ref](https://api-docs.deepseek.com/api/create-chat-completion)）。
- **Chat Completions 不支持在对话中途插入"不是模型生成的 tool call"**，但支持中途插入 system message。如果要插入 tool call，得改用 Anthropic API 或 Responses API（[tool calls guide](https://api-docs.deepseek.com/guides/tool_calls)）。
  - 【判断】这一条对 ergo 很关键。审批、提问这类卡片的结果，应当作为**模型自己发起的** `request_approval` / `ask_user` 工具调用的 tool result 回填；不要由系统伪造一条 tool call 插进历史。
- tool message 的 `content` 可以是字符串，也可以是 content parts 数组，里面可以放 image part（[API ref](https://api-docs.deepseek.com/api/create-chat-completion)）。所以工具可以直接返回截图。
  - 但 Vision 指南写的是"图片仅支持 user 消息，system/assistant 消息里放图会 400"（[vision](https://api-docs.deepseek.com/guides/vision)）。tool 消息里放图是否被实际接受，以 API ref 为准，【未实测】。

### 4.3 思考（thinking / reasoning）模式

来源：[thinking mode guide](https://api-docs.deepseek.com/guides/thinking_mode)、[API ref](https://api-docs.deepseek.com/api/create-chat-completion)。

- **默认开启思考，默认 effort 为 `high`**。
- 开关和档位有三种写法：
  - OpenAI 格式：`{"thinking":{"type":"enabled|disabled"}}` + `reasoning_effort: low|high|max`。用 OpenAI SDK 时，`thinking` 要放进 `extra_body`。
  - Anthropic 格式：`output_config.effort`。
  - Responses 格式：`reasoning.effort: none|low|high|max`。
- 档位映射：`minimal→low`、`medium/xhigh→high`、`ultra→max`。API ref 还写明 `reasoning_effort` 可以取 `none`，用来关闭思考。
- 思考模式下，`temperature`、`presence_penalty`、`frequency_penalty` 不报错但不生效。`top_p` 只在思考模式生效，有效范围 0.95–1.0。
- 思维链通过 `reasoning_content` 字段返回，与 `content` 同级。
- **带 tools 的请求必须把之前所有轮次的 `reasoning_content` 原样回传**，并且这些内容会被拼进上下文；漏传会直接 400。不带 tools 的请求回传了也会被忽略。
  - 【判断】这意味着 agent loop 里**推理 token 会累积成后续每一步的输入 token**，成本模型（§5）里已经计入。
- usage 里有 `completion_tokens_details.reasoning_tokens`（[API ref](https://api-docs.deepseek.com/api/create-chat-completion)）。

### 4.4 多模态：Flash 只认图片，不认音频、PDF、视频

来源：[vision guide](https://api-docs.deepseek.com/guides/vision)、[files API](https://api-docs.deepseek.com/guides/files_api)、[API ref](https://api-docs.deepseek.com/api/create-chat-completion)。

- `deepseek-flash` 接受 **JPEG、PNG、GIF、WebP** 四种格式。格式按文件内容识别，不看扩展名或 MIME。
- 三种传图方式：
  - `image_url` 里放 base64 data URL；
  - `image_url` 里放公网 http(s) URL：URL 不超过 8192 字符，图片不超过 32 MiB，60 秒内要下载完；
  - `{"type":"file","file_id":"file-api-…"}`，引用 Files API 上传的文件。也可以用 `file_data` 直接内联。
- `detail` 参数：`low` 会缩到 512×512 再推理；`high`、`original`、`auto` 目前都保留原图。
- **图片的 token 计费**：
  - 总像素低于约 544×544 的图会被放大；更大的图会缩到约 1300×1300 的像素总量；
  - **每张图最多 1024 token**，多图请求逐张独立计算。
- 限制：
  - 请求体 48 MiB；
  - 单图 32 MiB（走 file_id 可到 64 MiB）；
  - 每个请求最多 600 张图；
  - 单边最大 8192 px，一个请求里有 ≥15 张图时降到 4096 px。
- **Files API 只收这四种图片格式**：单文件 64 MiB，每用户存储 25 GiB，最多 10000 个文件，有效期 1 小时到 30 天，也可以设为永久。
- 文档里**完全没有提到音频输入、PDF/Office 文档输入、视频输入**。
  - Anthropic 兼容端点的兼容表里明确写了：`type="document"` 的 content block "Not Supported"，`image` 支持（[anthropic_api](https://api-docs.deepseek.com/guides/anthropic_api)）。
  - `deepseek-v4-pro` 是纯文本模型。
- 结论：**V4.1 Flash 是"文本 + 图片"多模态，不是全模态**。语音、文档、视频都必须由 ergo 先转换成文本或图片。

### 4.5 JSON 模式

来源：[json mode](https://api-docs.deepseek.com/guides/json_mode)、[API ref](https://api-docs.deepseek.com/api/create-chat-completion)。

- 用法是设 `response_format: {"type":"json_object"}`，同时 prompt 里必须出现 "json" 字样并给出示例。否则模型可能一直输出空白，直到撞上 max_tokens，看起来像"卡死"。
- 官方承认"偶尔会返回空 content"。
- 文档里**没有 `json_schema` 式的结构化输出**。
- 【判断】ergo 的卡片（计划、审批、提问）应该用 **strict 模式的 tool call** 来产生结构化数据，不要依赖 JSON mode。

### 4.6 上下文缓存（Context Caching）

来源：[kv_cache guide](https://api-docs.deepseek.com/guides/kv_cache)、[rate limit](https://api-docs.deepseek.com/quick_start/rate_limit)。

- 默认开启，基于硬盘，不用改代码。
- **命中规则（因为 Sliding Window Attention 而改过）**：每个缓存前缀是一个独立、完整的单元，后续请求必须**完整匹配**某个单元才算命中。单元在以下三种时机落盘：
  1. 每个请求在"用户输入末尾"和"模型输出末尾"各产生一个单元；
  2. 系统检测到多个请求有公共前缀时，把这个公共前缀单独落盘；
  3. 长输入或长输出按固定 token 间隔切出单元。
- usage 里有 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。
- 缓存是 best-effort：构建要几秒，不再使用后通常几小时到几天内清除。
- `user_id` 参数可以做 KVCache 隔离（[rate limit](https://api-docs.deepseek.com/quick_start/rate_limit)）。
- 【判断】对 agent loop 来说，规则 1 很有利："上一轮输入 + 上一轮输出"整体就是一个单元，下一步只要在末尾追加 tool result，就能整段命中。前提是**前缀必须逐字节稳定**：
  - system prompt 里不要放时间戳；
  - 工具列表顺序固定；
  - 历史只追加、不改写；
  - `reasoning_content` 原样回传。
  - compaction、改写记忆注入块这类操作都会让缓存失效。

### 4.7 价格与限速

价格是每百万 token。来源：[pricing（英文）](https://api-docs.deepseek.com/quick_start/pricing)、[pricing（中文）](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)。

| | Flash 空闲 | Flash 高峰 | V4-Pro 空闲 | V4-Pro 高峰 |
|---|---|---|---|---|
| 输入（缓存命中） | $0.003 / ¥0.02 | $0.006 / ¥0.04 | $0.022 / ¥0.15 | $0.044 / ¥0.30 |
| 输入（缓存未命中） | $0.15 / ¥1 | $0.30 / ¥2 | $0.66 / ¥4.5 | $1.32 / ¥9 |
| 输出 | $0.60 / ¥4 | $1.20 / ¥8 | $1.98 / ¥13.5 | $3.96 / ¥27 |

- **高峰时段**：北京时间工作日 9:00–12:00、14:00–18:00（UTC 01–04、06–10），中国法定节假日除外。其余时段、周末和法定节假日全天都按空闲价，空闲价是高峰价的一半。这套价格自 2026-09-10 04:00 UTC 起生效（[news260910](https://api-docs.deepseek.com/news/news260910)）。
- 缓存命中价只有未命中价的 **1/50**。所以缓存命中率是成本的第一杠杆。
- **限速**：只公布了账号级并发上限，Flash 2500、Pro 500，超出返回 429；可以免费申请扩容。文档**没有公布 RPM/TPM**。
- 其他行为：
  - 推理开始前，服务端会持续发空行（非流式）或 `: keep-alive` 注释（流式）来保活；
  - 请求发出后 10 分钟还没开始推理，服务端会断开连接（[rate limit](https://api-docs.deepseek.com/quick_start/rate_limit)）。
- 【判断】单用户场景下，2500 并发碰不到。

### 4.8 pi-ai 对 DeepSeek 的原生支持

来源：`@earendil-works/pi-ai@1.0.4`（2026-10-05，[npm](https://registry.npmjs.org/@earendil-works/pi-ai/latest)）。源码在 [packages/ai/src/providers/deepseek.ts](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/ai/src/providers/deepseek.ts)、[api/openai-completions.ts](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/ai/src/api/openai-completions.ts)；模型数据来自发布包里的 `dist/providers/data/deepseek.json`。

- **provider 名为 `deepseek`**，由 `deepseekProvider()` 创建，走 `openai-completions` API，baseUrl 是 `https://api.deepseek.com`，鉴权读环境变量 `DEEPSEEK_API_KEY`。
- **内置目录里的两个模型**：

| 字段 | `deepseek-flash`（name: "DeepSeek V4.1 Flash"） | `deepseek-v4-pro`（"DeepSeek V4 Pro"） |
|---|---|---|
| `input` | `["text","image"]` | `["text"]` |
| `reasoning` | true | true |
| `thinkingLevelMap` | low→low，high→high，max→max（minimal、medium 为 null） | 只有 high、max |
| `contextWindow` / `maxTokens` | 1,000,000 / 384,000 | 同左 |
| `cost`（$/M） | input 0.3、output 1.2、cacheRead 0.006 | 1.32 / 3.96 / 0.044 |
| `compat` | `thinkingFormat:"deepseek"`、`requiresReasoningContentOnAssistantMessages`、`supportsStrictMode`、`maxTokensField:"max_tokens"` | 同左，外加 `supportsMidConvoSystemMessages` |
| 图片预处理 | 缩放上限 2000×2000、4.5 MB、JPEG 质量 80 | — |

- **`thinkingFormat:"deepseek"` 的行为**：
  - 调用时传了 `reasoningEffort`，就发送 `thinking:{type:"enabled"}`，并按映射表发送 `reasoning_effort`；
  - 没传，就发送 `thinking:{type:"disabled"}`。
  - 注意：**pi-ai 的默认行为（不思考）和 DeepSeek API 的默认行为（思考 high）相反**。
  - 源码：[openai-completions.ts L928-937](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/ai/src/api/openai-completions.ts#L928-L937)。
- **工具结果里的图片**：pi-ai 先发一条 `role:"tool"` 的文本消息；只有图片时文本写 "(see attached image)"。然后**另起一条 user 消息**，用 `image_url` 把图片带上。不会把图片直接塞进 tool 消息（[同文件 L1406-1460](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/ai/src/api/openai-completions.ts#L1406-L1460)）。
- 缓存命中从 `prompt_cache_hit_tokens` 读取（同文件）。
- 目录从 0.86.0（2026-09-19）起改为 `deepseek-flash`，并刷新了价格（[CHANGELOG](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/ai/CHANGELOG.md)，#9423）。
- 前作当年就是走 openai-completions 兼容层，并设了 `thinkingFormat:"deepseek"`（调研 01，未公开）。
- **坑**：pi-ai 目录里的 `cost` 用的是**高峰价**，而且不区分时段。它算出的成本在空闲时段会**高估 2 倍**。
  - 【建议】ergo 自己按请求时间（北京时间、工作日、法定节假日）重算费用，pi-ai 的 cost 只当上限参考。

### 4.9 主模型不认的输入，ergo 怎么处理

以下都是【建议】。工具选型未逐一核实，标【未核实】的需要后续单独评估。

| 输入 | 给 LLM 的形态 | 处理链 |
|---|---|---|
| 图片 | Flash 直接看图，用 `image_url` 或 data URL | 上传时先按 pi-ai 的 resize 规则预缩放。第一次看图后，把模型生成的 caption/OCR 文本缓存到媒体元数据里（按内容 hash）。这样：① 主模型换成纯文本的 Pro 时可以退化为"文字描述"；② 记忆整理、检索都用这份文本；③ 长历史里的旧图可以只留描述，降低 token |
| 主模型是纯文本（V4-Pro） | 文字描述 | 设一个"**视觉代理**"子调用：用 `deepseek-flash` 做 caption + OCR，结果作为文本 part 注入。成本：每张图 ≤1024 输入 token |
| 语音消息 | 转写文本，标注"〔语音转写〕"，可附语言和置信度 | 本地 Whisper；原音频作为附件保留（见 §2、§6） |
| 文本类文档（txt/md/代码/csv） | 直接取文本 | 超过阈值（如 20k token）就不整篇塞进上下文，改成"文档 artifact + `read_document(id, range)` 工具"按需读取 |
| PDF（有文本层）/DOCX/XLSX/PPTX | 抽取出的文本或 Markdown | 可选 pdf.js / `pdftotext`、mammoth、SheetJS 等库【未核实】；保存抽取结果，按 hash 缓存 |
| 扫描版 PDF、图片型文档 | 逐页渲染成图片，交给 Flash 识别，或用本地 OCR | Flash 每页 ≤1024 token；也可以用本地 OCR（如 PaddleOCR / Tesseract）【未核实】 |
| 视频 | 关键帧图片 + 音轨转写 | ffmpeg 抽音轨，交给 Whisper；按场景切换或固定间隔抽帧，限定上限（如 ≤20 帧），帧图交给 Flash |

## 5. 粗略成本模型（DeepSeek V4.1 Flash）

> 本节全部是【估算】，不是实测。单价取自 §4.7。每个场景都给出高峰价和空闲价，USD 与 CNY 分别按官方各自的价目表计算（两套价格不是按汇率精确换算的）。计算脚本的逻辑附在本节末尾，方便改假设后重算。

### 5.1 公共假设

- Token 换算：官方给的经验值是 1 个中文字符 ≈ 0.6 token，1 个英文字符 ≈ 0.3 token（[token usage](https://api-docs.deepseek.com/quick_start/token_usage)）。
- 每次 LLM 调用的固定前缀约 8k token：秘书 system prompt 约 3k，工具定义约 4k，记忆注入约 1k。
- 带 tools 时，历史 `reasoning_content` 必须回传，并计入输入（§4.3）。
- 思考档位用 `low` 或 `high`。每次调用的输出（含推理）为 500–1000 token。
- 本地 Whisper 和本地 TTS 不产生 API 费用。
- 图片每张 ≤1024 token（§4.4）。一天 5–10 张图只增加几千 token，可以忽略。

### 5.2 各场景结果

| 场景 | 关键假设 | 输入 token（命中/未命中） | 输出 token | 高峰 | 空闲 |
|---|---|---|---|---|---|
| **(a) 日常对话 50 轮/天** | 每轮平均 1.5 次调用（有时查一下记忆或工具），共 75 次；每次输入 = 8k 固定 + 平均 10k 历史 = 18k；命中率 85%；每次输出 800 | 1.35M（1.15M / 0.20M） | 60k | **$0.14 ≈ ¥0.93** | $0.07 ≈ ¥0.47 |
| **(b) 一个长程任务，约 100 次工具调用** | 100 次调用；起始上下文 12k（system、工具、计划）；每步增长 2.2k（tool result 约 1.5k + 推理约 400 + 参数和正文约 300），第 100 步上下文约 230k；每步输出 650；不做 compaction | 12.09M | 65k | 理想命中（只有新 tool result 未命中）：**$0.20 ≈ ¥1.3**；保守（命中 80%）：**$0.86 ≈ ¥5.7** | $0.10 / $0.43 |
| **(c) 多 agent 项目一天**（秘书 + PM + 2 个 worker） | 秘书 = (a) + 20 次协调调用，每次 20k；PM 150 次调用，每次 30k、命中 85%、输出 1k；每个 worker 一天跑 3 个 (b) 规模的任务，共 6 个 | 78.8M | 616k | 理想：**$1.77 ≈ ¥11.8**；保守：**$5.75 ≈ ¥38** | $0.89 / $2.88 |
| **(d) 夜间记忆整理** | 当天素材约 100k token（对话可见文本、任务日志摘要、项目事件）；10 次抽取调用 × 20k；20 次合并去重调用 × 15k（含召回的已有记忆）；1 次总览 60k；命中率 30%（只有 system prompt 能复用）；输出 80k（思考 high） | 0.56M | 80k | $0.22 | **$0.11 ≈ ¥0.7**（夜里本来就是空闲时段） |

细项：(c) 里秘书 $0.18，PM $0.41；6 个 worker 任务理想情况下共 $1.19，保守情况下共 $5.17（均为高峰价）。

### 5.3 读数与判断

- 【判断】**纯对话一个月只要几美元**：按 (a) 算，约 $2–4/月，约 ¥15–30。**真正的成本大头是长程任务和项目**，而它们的成本主要取决于**缓存命中率**，模型单价反而是次要的：
  - 同一个 100 步任务，命中率从约 99% 降到 80%，成本涨了 4 倍多（$0.20 → $0.86）；
  - 因为未命中价是命中价的 50 倍。
- 【建议】让前缀保持稳定：
  - 工具定义排序固定；
  - system prompt 不放当前时间（时间放进最新一条 user 消息）；
  - 历史只追加；
  - 慎用 compaction。compaction 能把 (b) 的总输入从 12.1M 降到约 8.2M（上下文封顶 100k 时），但每次压缩都会让后面的前缀缓存全部失效。值不值得，要看实测的命中率。
- 【建议】**可延后的任务放到空闲时段**：工作日 18:00 以后、周末。空闲时段直接便宜一半。夜间记忆整理天然就在空闲时段。
- 【判断】如果把 worker 换成 `deepseek-v4-pro`：按 (b) 理想命中率算是 $1.00，保守算是 $3.87（高峰价），**约为 Flash 的 4.5–5 倍**，而且 V4-Pro 不能看图。
- 【建议】在 V4.1 Pro 发布、并且做过实测对比之前，默认全部用 Flash，按角色分档调节 `reasoning_effort`：
  - 秘书闲聊用 `low`；
  - 规划和审批用 `high`；
  - 疑难问题用 `max`。
- 【建议】ergo 的 usage 账本要逐次调用记录以下字段：`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`reasoning_tokens`、时段（高峰/空闲）、角色、任务 ID。用真实命中率替换本节的假设。pi-ai 的 cost 字段按高峰价计（§4.8），不能直接用。

<details><summary>计算方法（Python 伪代码）</summary>

```python
P_peak = dict(hit=0.006, miss=0.30, out=1.20)   # USD / 1M, deepseek-flash
P_off  = dict(hit=0.003, miss=0.15, out=0.60)
cost = lambda hit, miss, out, p: (hit*p['hit'] + miss*p['miss'] + out*p['out']) / 1e6
# (b) 长程任务：第 k 步输入 = 12000 + 2200*k，k=0..99，总输入 12.09M
inputs = [12000 + 2200*k for k in range(100)]
total_in = sum(inputs)                                   # 12,090,000
ideal_miss = 12000 + 1500*100                            # 只有新 tool result 未命中
cost(total_in - ideal_miss, ideal_miss, 100*650, P_peak) # ≈ 0.198
cost(total_in*0.8, total_in*0.2, 100*650, P_peak)        # ≈ 0.861
```
</details>

## 6. 建议：ergo 的消息数据模型（parts-based）

> 本节是【建议】，由 §1–§5 的事实推出。原则上与 `06-long-tasks-hitl-interruptions.md` 一致：event log 是唯一真相，审批表落 SQLite（WAL）。也与前作的做法一致：聊天框里只放总结，细节进详情；流式增量不要逐条落盘。

### 6.1 设计原则

1. **信封 + 有序 parts**。
   - 一条消息由两部分组成：
     - 信封：id、作者、时间、回复/引用、编辑/删除、反应、投递状态；
     - 一个有序的 `parts[]`。
   - parts 的形状向 AI SDK 的 `UIMessage.parts` 靠拢（text / reasoning / file / tool / data-*），方便将来接现成组件。
   - 再用 Telegram/WhatsApp 的概念补齐 messenger 能力：reply + quote、reactions、edit_date、相册、语音波形、投递与已读。
   - 相册不需要 `media_group_id` 这种外挂字段。一条消息里放多个 image/video part 就是相册。Telegram 之所以用 group id 把多条消息"粘"在一起，是因为它的一条消息只能带一个媒体（见 §1）。
2. **媒体永远不内联**。
   - part 里只放 `MediaRef`，指向内容寻址的 blob（sha256）。
   - 这个思路和 Telegram 的 file_id 复用、WhatsApp 的 media id 是同一个："上传一次、到处引用"。
3. **UI 视图 ≠ 模型视图**。
   - 持久化的是 UI 视图。发给 LLM 之前，由纯函数 `toModelContent(message, modelCaps)` 做投影：
     - voice → 转写文本；
     - image → Flash 的 image_url，或者给纯文本模型的 caption；
     - file → 抽取出的文本，或文档引用；
     - card → 一行文字摘要；
     - tts → 不进模型。
   - 投影规则要带版本号，保证前缀稳定，缓存才能命中（§4.6）。
4. **卡片是可原地更新的 typed data part**。
   - 每张卡有稳定的 `cardId`，状态迁移靠 `part.update` 事件原地改。
   - 这相当于 Telegram 的 `editMessageReplyMarkup`，或 AI SDK 里带 id 的 data part 的 reconcile。
   - 审批卡、问题卡的按钮语义照搬 Telegram 的 callback 模型：按钮只带短 `actionId`（类似 `callback_data` ≤64 字节）；服务端校验后必须回一个 ack（类似 `answerCallbackQuery`），再更新卡片。
5. **所有异步派生结果都是"part 的状态"，不另开消息**。
   - 转写、缩略图、OCR、TTS 合成都挂在原来的 part 上，用 `status: pending|ready|error` 表示进度。前端据此显示转圈或结果。

### 6.2 类型草案（TypeScript）

```ts
type ULID = string;
type Sha256 = `sha256:${string}`;

interface MediaRef {
  hash: Sha256;               // 原始字节的 sha256，同时是存储键和 ETag
  mime: string;               // 以服务端嗅探结果为准
  bytes: number;
  filename?: string;
  width?: number; height?: number;
  durationMs?: number;
  thumb?: { hash: Sha256; width: number; height: number };   // 派生缩略图（≤320px webp）
  placeholder?: string;       // 极小的 base64 模糊图，首屏占位
}

interface ChatMessage {
  id: ULID;                   // 客户端先生成，作为幂等键和乐观 UI 的键
  conversationId: string;     // 秘书主会话 / 某项目频道
  seq?: number;               // 服务端提交后分配，会话内单调递增
  author: { kind: "user" | "agent" | "system"; agentId?: string; role?: "secretary" | "pm" | "worker" };
  createdAt: string;
  editedAt?: string;          // 对应 Telegram 的 edit_date
  deletedAt?: string;         // 墓碑：保留 id 和 seq，清空 parts
  status: "draft" | "uploading" | "queued" | "streaming" | "complete" | "error" | "cancelled";
  readByUserAt?: string;      // agent 消息被用户看到的时间（"已读"只需要单向）
  replyTo?: { messageId: ULID; partId?: string; quote?: { text: string; offset?: number } };
  forwardedFrom?: { messageId: ULID; conversationId: string };   // 项目频道 → 秘书主会话的转发
  reactions?: { emoji: string; by: "user" | string; at: string }[];
  parts: Part[];
  meta?: { runId?: string; taskId?: string; projectId?: string; model?: string; usage?: Usage };
}

type Part =
  | { type: "text"; id: string; text: string; format?: "markdown" | "plain" }
  | { type: "reasoning"; id: string; text: string }                      // 默认折叠，可以不持久化
  | { type: "image"; id: string; media: MediaRef; caption?: string;
      vision?: { caption?: string; ocr?: string; model: string; status: Status } }
  | { type: "video"; id: string; media: MediaRef; poster?: MediaRef; caption?: string;
      playback?: MediaRef;                                               // 转码后的 H.264/AAC mp4（faststart）
      transcript?: Transcript; keyframes?: MediaRef[] }
  | { type: "voice"; id: string; media: MediaRef; durationMs: number;
      waveform: number[];                                                // 64–100 个 0..31 的整数（仿 Telegram 5-bit）
      origin: "user-recording" | "tts";
      transcript?: Transcript;                                           // 用户录音：Whisper 结果
      tts?: { sourcePartIds: string[]; voiceId: string; engine: string; status: Status };
      playedAt?: string }                                                // "已听"
  | { type: "audio"; id: string; media: MediaRef; title?: string; caption?: string }   // 音乐或普通音频文件
  | { type: "file"; id: string; media: MediaRef; caption?: string;
      extract?: { status: Status; textRef?: MediaRef; pages?: number; tokens?: number; method: string } }
  | { type: "tool"; id: string; toolCallId: string; name: string;
      state: "input-streaming" | "running" | "done" | "error"; summary?: string;
      input?: unknown; output?: unknown; display: "hidden" | "line" | "full" }
  | { type: "card"; id: string; card: Card };

type Status = "pending" | "running" | "ready" | "error";
interface Transcript { status: Status; text?: string; lang?: string; engine?: string;
  segments?: { startMs: number; endMs: number; text: string }[]; editedByUser?: boolean }

type Card =
  | { kind: "plan"; cardId: string; planId: string; version: number; title: string;
      steps: { id: string; label: string; sensitive?: boolean }[];
      grants?: { id: string; label: string; checked: boolean }[];
      state: "proposed" | "approved" | "rejected" | "superseded"; actions: Action[] }
  | { kind: "approval"; cardId: string; approvalId: string; title: string; why: string;
      risk?: "low" | "medium" | "high"; preview?: MediaRef;
      state: "pending" | "approved" | "rejected" | "expired" | "superseded";
      expiresAt?: string; decidedAt?: string; actions: Action[] }
  | { kind: "progress"; cardId: string; taskId: string; title: string;
      phase: string; percent?: number;
      steps: { label: string; state: "todo" | "doing" | "done" | "failed" | "skipped" }[];
      lastEvent?: string }
  | { kind: "question"; cardId: string; questionId: string; prompt: string;
      choices?: Action[]; multiSelect?: boolean; allowFreeText: boolean;
      state: "open" | "answered" | "expired"; answer?: { actionIds?: string[]; text?: string } };

interface Action { id: string; label: string; style?: "primary" | "danger" | "default"; confirm?: string }
```

**与 AI SDK v7 `UIMessage` 的映射**（用于协议兼容，见 §3.7）：

| ergo part | AI SDK part | 说明 |
|---|---|---|
| `text` / `reasoning` | `text` / `reasoning` | 一一对应 |
| `tool` | `tool-${name}` / `dynamic-tool` | ergo 的 `state` 是 AI SDK 状态机的简化版。审批状态不放在 tool part 上，单独做成 approval 卡 |
| `image` / `file` | `file{mediaType, url, filename}` | url 填 `/media/{hash}`。流式 `file` chunk 会丢 filename（§3.1），所以媒体 part 一律走 `data-*` 或在 `message.created` 里整体下发 |
| `voice` / `video` / `audio` | `data-voice` / `data-video` / `data-audio` | AI SDK 没有对应类型 |
| `card` | `data-plan` / `data-approval` / `data-progress` / `data-question` | 用 `id = cardId` 原地替换（[streaming data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data)） |
| 信封字段（createdAt、author、replyTo、reactions、status、seq） | `metadata` | AI SDK 的 UIMessage 没有这些字段 |

几点说明：

- **TTS 回复也用 `voice` part 表示，靠 `origin:"tts"` 区分来源。**
  - 前端可以复用同一个语音气泡组件：波形、倍速、已听状态都通用。
  - 它和文本 part 挂在同一条 agent 消息里，通过 `tts.sourcePartIds` 指回朗读的是哪段文字。
- **`reasoning` part 是否持久化，做成可配置项。**
  - DeepSeek 带 tools 时要求回传 `reasoning_content`（§4.3），所以模型侧的会话存储（pi 的 transcript）必须保存它。
  - UI 消息里可以只存一个摘要，或者干脆不存。
  - 也就是说，pi 的模型 transcript 和 UI 消息是**两份投影**，都从同一份 event log 推导出来。

### 6.3 媒体存储（个人数据目录，内容寻址）

```
<personal-data>/media/
  blobs/sha256/ab/cd/abcdef…            # 原始字节，不可变；写入时先写临时文件，校验 hash 后再 rename
  derived/ab/cdef…/thumb-320.webp       # 派生物，按 (源 hash, 配方, 配方版本) 命名，随时可以重建
                    poster.jpg / play.mp4 / play.m4a / wave-100.json / transcript.whisper-large-v3.json / ocr.txt / pages/0001.png
  index.sqlite                          # media 表：hash, mime, bytes, created_at, first_filename, refcount, exif_stripped …
```

- **去重和复用**：
  - 客户端先算 sha256。注意 `SubtleCrypto.digest()` 不支持流式输入，必须一次读入整个文件，而且只能在安全上下文里用（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)）。所以大文件要在 Worker 里用增量 hash 库算，或者干脆由服务端算。
  - 算好后先 `HEAD /media/{hash}` 查一下：已经存在就跳过上传。
  - 这和 Telegram 的"同一个 file_id 可以重复发送、不用重传"是同一个思路（§1）。
- **HTTP 服务**：
  - `GET /media/{hash}` 返回 `ETag: "<hash>"` 和 `Cache-Control: immutable`。
  - **必须支持 Range（206）**，否则 iOS/Safari 系的媒体播放不能随机访问："HTTP servers hosting media files for iOS must support byte-range requests"（[Apple Safari Web Content Guide](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/CreatingVideoforSafarioniPhone/CreatingVideoforSafarioniPhone.html)）。
  - 【判断】WebView 里的 `<video>` 拖进度条同样依赖 Range。
- **上传**：
  - 小文件（< 8 MB）用一次 `PUT /media` 就够。
  - 视频和大文件走可续传分片（tus 协议或自定义分片，见 §2）。
  - 服务端收齐后校验 hash，嗅探真实 MIME，剥掉 EXIF/GPS（可配置），再触发派生任务：缩略图、海报帧、波形、转写、文档抽取、播放用转码。
- **引用计数与 GC**：
  - 消息删除只写墓碑。
  - blob 的 refcount 降到 0 后，过 N 天由 GC 回收。
  - 派生物可以随时删，需要时再重建。
- **隐私**：
  - 媒体只存在个人数据目录，不进框架仓库。
  - `index.sqlite` 和 event log 一起备份。
  - 给远端 LLM 发图片时，只发经过缩放的副本（pi-ai 已经会按 2000px / 4.5MB 预缩放，见 §4.8）。

### 6.4 流式传输：一条 WebSocket 事件流，按 seq 断点续传

- **传输层**：WebSocket 是主通道，因为要双向：发消息、点按钮、"正在录音"状态、已读回执都要上行。SSE 只作为只读降级通道。
- **每个事件的结构**：

  ```ts
  { seq, conversationId, type, ... }
  ```

  `seq` 在会话内单调递增。客户端重连时带上 `lastSeq`，服务端从 event log 补发缺失事件。
- **下行事件类型**：

| 事件 | 含义 | 是否落盘 |
|---|---|---|
| `message.created` | 完整信封，parts 可以为空 | 是 |
| `chunk {messageId, runId, chunk}` | `chunk` 原样采用 AI SDK v7 的 `UIMessageChunk`：`text-start/delta/end`、`reasoning-*`、`tool-input-*`、`tool-output-*`、`data-*`（[chunks](https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts)）。下文的 `part.start/delta/end` 指的就是这些 chunk | 只有 `*-end` 和最终 part 落盘（吸取前作的教训：pi 把每个增量都写进 JSONL，一轮就上万行）。Telegram 的 `sendMessageDraft` 也是同样的思路：草稿流和持久消息分开（§1.7） |
| `part.update` | 卡片状态、tool 状态、转写/缩略图/TTS 就绪、进度百分比。用带同一 id 的 `data-*` chunk 表达，也可以发成 ergo 自己的事件 | 是（进度类可以节流） |
| `message.updated` / `message.deleted` / `reaction` | 编辑、撤回、反应 | 是 |
| `message.status` | `queued → streaming → complete/error/cancelled` | 是 |
| `ack` | 回应客户端的 action、send，带 `clientNonce` | 否 |

- **上行动作**：

| 动作 | 用途 |
|---|---|
| `send {message}` | 发消息。message 里的 parts 只引用已上传的 MediaRef |
| `action {cardId, actionId, clientNonce, payload?}` | 点击卡片按钮 |
| `read {upToSeq}` | 已读回执 |
| `typing` / `recording` | 输入中 / 录音中状态 |
| `cancel {runId}` | 中止当前运行 |
| `edit` / `delete` / `react` | 编辑、删除、反应 |

- **卡片按钮的闭环**（仿 Telegram callback_query）：
  1. 客户端发出 `action`，按钮立即进入 loading 状态；
  2. 服务端在审批表上做条件更新 `UPDATE … WHERE state='pending'`，保证先到先得、幂等；
  3. 服务端回 `ack`（类似 `answerCallbackQuery`）；
  4. 服务端推送 `part.update`，卡片变为"已批准 · 10:32"，按钮消失（类似 `editMessageReplyMarkup`）；
  5. 等待中的 agent 拿到 `request_approval` 工具调用的 tool result，继续运行。
  - 这个回填方式符合 DeepSeek Chat Completions 的限制：不能伪造 tool call 插进历史（§4.2）。
  - 如果用户在别的前端（比如将来的 Telegram bot）上做了同一个决定，走的也是同一个审批表。
- **多前端一致性**：
  - Web 端、鸿蒙端、Android 端都只是这条事件流的订阅者，前端本身不持有状态（与 CONTEXT.md 中"前端"的定义一致）。
  - 照搬 OpenClaw 的做法：实时事件只负责"投递"，`history(conversationId, beforeSeq/afterSeq)` 从 event log 重建出来的消息才是权威。客户端只保留一段乐观更新的尾部，等历史追上来就用权威数据替换（[webchat.md](https://github.com/openclaw/openclaw/blob/main/docs/web/webchat.md)）。
  - 发送时带 `idempotencyKey`，取消息的 ULID 即可。

### 6.5 语音进、语音出

**语音进**（用户发语音）：

```
按住录音（MediaRecorder：能录 opus 就录 opus，否则 mp4/aac）
  → 本地算波形（AnalyserNode 实时画；结束后降采样到 64–100 个点）
  → 上传 blob → 发出消息：voice part，transcript.status = pending
     （气泡立刻出现，可以播放）
  → daemon：ffmpeg 转成 16k mono WAV → 本地 Whisper → part.update(transcript ready)
  → 秘书收到的输入 = "〔语音转写〕……"（附语言；低置信时附提示）
```

- 【建议】做两种模式，可配置：
  - "直接发"：转写完成后自动交给 agent；
  - "先看转写再发"：转写文本进入输入框，用户可以修改，设 `editedByUser=true`。
- 【建议】长录音以后可以把 `timeslice` 分片实时推给 daemon，做流式转写（见 §2）。v1 先做"录完上传"。
- 原音频永久保留，供回放和记忆整理时复核。

**语音出**（秘书用 TTS 回复）：

```
agent 文本流式输出（part.delta）
  → 句子切分器：遇到句末标点且长度 ≥ N 就切一句；跳过代码块、表格、URL；卡片只念一句摘要
  → 本地 TTS（voiceId、语速可配置）逐句合成 → 以分段方式推给前端，前端按顺序播放
  → 整段结束后拼成一个文件（opus 或 m4a），写入 blobs，挂成 voice part(origin:"tts")，补上 waveform
```

- **触发策略**，可配置：
  - 始终朗读；
  - 用户用语音提问时才用语音回复（"以语音回应语音"）；
  - 只在免提模式下朗读；
  - 关闭。
- **缓存键**：`hash(规范化文本 + voiceId + engine@version + 语速)`，同一段话不重复合成。
- 【判断】本机已经有 `audio-cpp` 技能，支持本地 TTS、声音克隆和 ASR，可以作为本地 TTS/ASR 引擎的候选，但【未评估】它的质量、延迟和中文表现。

### 6.6 视频：第一天就要预留的部分

- 数据模型里已经有 `video` part，包含 `poster`、`playback`、`durationMs`、`width`/`height`，以及 `keyframes`/`transcript`（给 LLM 用）。
- 上传走可续传分片。服务端生成海报帧，并按需转码成广泛兼容的播放格式。
  - 【判断】H.264/AAC MP4 + faststart 是最稳妥的播放格式。HEVC、AV1 在各种 WebView 里的支持参差不齐，【未核实】。
- 服务端必须支持 Range 请求（§6.3）。
- 进入 LLM 的形态：关键帧（每张 ≤1024 token）+ 音轨转写（§4.9）。不要把整段视频交给模型。
- 媒体大小上限要自己定。可以参考 Telegram Bot API 的 50 MB 上传和 20 MB 下载限制、WhatsApp 的 16 MB 视频限制（§1）。【建议】个人系统可以放宽到 2 GB，但必须走分片上传。

## 7. 开放问题

**模型**

1. **V4.1 Pro 什么时候上线？能力和价格如何？**
   - 官方目前只说过"至未来 V4.1 Pro 上线之前"，然后又改口继续提供 V4 Pro（§4.1）。
   - 要等它发布后，再决定 PM 和 worker 是否换成 Pro。
   - 换之前要用真实输出回归集做对比：前作只在 DeepSeek 上校准过。
2. **思考档位按角色怎么分？**
   - pi-ai 不传 `reasoningEffort` 就会关闭思考（§4.8）。
   - 秘书闲聊用 low 还是 non-thinking？需要实测延迟和质量。
3. **缓存命中率要实测。**
   - §5 的保守估算（80%）和理想估算（约 99%）差了 4 倍。
   - 需要在 pi 的 agent loop 下实测 `prompt_cache_hit_tokens`，并确认 compaction 的策略。
4. **工具结果里的图片怎么传？**
   - 是走 pi-ai 的"追加一条 user 消息"，还是直接放进 tool message？API ref 允许后者，但 Vision 指南说图片只能放在 user 消息里（§4.2）。
   - 两种方式对缓存命中和模型效果的影响都要实测。

**部署与客户端**

5. **局域网 HTTPS 方案**（决定麦克风能不能用）：
   - 自签 CA 装进手机信任，还是带公网证书的域名或隧道？
   - App 内打包 UI 后，访问 daemon 会遇到 mixed content 和 Local Network Access 的限制（§2.3），需要真机验证。
6. **ArkWeb 实测**（可以用本机的 harmonyos-dev 工具链跑探测页）：
   - `MediaRecorder.isTypeSupported` 的结果；
   - rawfile 或 `isSecure` 自定义 scheme 下是否为 secure context；
   - 是否支持 fetch 流和 `ReadableStream`；
   - 能否 Range 播放 `<video>`。
7. **录音放在原生层还是 Web 层？** 原生录音再通过 JS bridge 交给 Web，可以绕开 WebView 的权限链，但要维护两套实现【未调研】。

**语音**

8. **Whisper 选型**：whisper.cpp 还是 faster-whisper？选哪个模型？中文准确率和 GPU 占用如何？要不要做流式转写？
9. **本地 TTS 引擎和音色**：
   - 本机已有 audio-cpp 技能【未评估】。
   - 要不要做"秘书专属音色 / 克隆音色"？涉及隐私和授权。
   - "以语音回语音"的默认策略是什么？

**数据与存储**

10. **媒体保留策略**：
    - 原始录音和原始视频是否永久保留？
    - EXIF/GPS 默认剥离吗？
    - 转码后是否删除原件？
    - 媒体会被记忆整理引用，所以与记忆的保留策略要一起定。
11. **相册：一条消息多个 part，还是 N 条消息共享 group id？**
    - 本文选前者（§6.1）。
    - 代价是对相册里单张图片回复或加反应时，要在 `replyTo` 里带上 `partId`。
    - Telegram 的做法正好相反（§1.1）。
12. **Telegram bot 作为另一个前端**：
    - 消息模型要能双向映射：ergo 卡片 ↔ InlineKeyboard，voice ↔ sendVoice（OGG/Opus）。
    - 审批的回调走同一张审批表。
    - 本文的模型已经按这个方向设计，但还没有逐字段验证。
