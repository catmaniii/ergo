# 调研 08：本机基础设施（audio.cpp / Whisper / 本地服务管理器 / 华为家庭存储 / Node 与 GPU）

> - 调研日期：2026-10-07。全程只读：没有启停任何服务，没有改任何文件（本文除外），没有浏览 NAS 内容。
> - 目的：二狗 v2 新增四项要求——秘书用 audio.cpp 的 TTS 说话且音色可配、Web UI 语音输入由本地 Whisper 转写、所有服务端进程由本地服务管理器（LSM）托管并支持按服务开机自启、个人数据定期备份到华为家庭存储。本文盘点这些要求依赖的现有设施。
> - 标注：没标的是【事实】，来自文件、命令输出或日志；【建议】【推测】是本文作者的判断。
> - 路径缩写：`AC/` = `D:\code\claudecode\audio.cpp`，`LSM/` = `D:\code\claudecode\local_service_manager`，`DM/` = `D:\code\claudecode\drama_maker`。

---

## 0. 一页摘要

1. **audio.cpp 是现成的本地语音引擎，TTS 和 ASR 都能做，但没有 Whisper。** 单个 C++/ggml 二进制，44 个模型家族，有 OpenAI 形状的 HTTP server。常驻实例是 `127.0.0.1:8090`，由 LSM 托管（`LSM/registry/services/audiocpp.yaml`），目前只装载 **Fish Audio S2 Pro**（中文可用，靠参考音频克隆音色）。
2. **音色可配的现实做法**：每次请求带 `voice_ref`（服务器本地 WAV 路径）+ `reference_text`（这段参考音频的准确文本），二者必须同时给。`AC/voices/` 下已有约 60 个中文参考音色和 `voices.json` 统一音色库，drama_maker 也在用。Fish **没有** 语速参数，也没有内置音色；语速靠 ffmpeg 后处理，情绪靠台词里的方括号指令。
3. **延迟偏高**：Fish 冷加载约 29 s，本机合成约 1 倍实时（drama 实测），也就是说一句 8 s 的话要合成 8 s 左右，而且 **Fish 不支持流式输出**。这个服务和 drama/agentsense 共用，按模型串行排队。对话式秘书要么接受"整句合成完再播"，要么换一个支持流式、更快的中文模型（已装的 OmniVoice 是候选）。
4. **本地没有任何 Whisper 服务。** 有的是：全局 Python 里的 `faster-whisper 1.2.1` 库和 HF 缓存里的 `large-v3/small/tiny` 权重（只被 bili_video 等一次性批处理脚本用过）；vibecraft 的 `.venv` 里有 FunASR（流式 paraformer-zh + SenseVoiceSmall，CPU，进程内）；audio.cpp 自己装了 Qwen3-ASR-0.6B、Fun-ASR-Nano（中文最佳）、Parakeet。
5. **audio.cpp 的硬坑**：同一个 server 进程同时托管 ASR 和 TTS 会互相污染，TTS 会输出噪声（`DM/docs/pitfalls.md:486`）。所以语音输入若走 audio.cpp，**必须另起一个只放 ASR 的 server 实例**。
6. **LSM**：Node 写的常驻管理器（`127.0.0.1:7420`，WebUI + WebSocket），一服务一 YAML 注册表、钩子启停、四档探活、依赖编排、场景、哨兵，公网走"本机 ssh -R → VPS nginx 443 SNI 前门 → 8443 server_name"。LSM 自己由**登录时**计划任务 `LocalServiceManager` 拉起，外加每 5 分钟一次的看门狗触发。
7. **"按服务开机自启"目前不存在**，但有一个事实上的近似：`autoRestart.enabled` 且 `desired=running` 的服务，在重启机器后约 20 s 内会被 LSM 当成"挂了"重新拉起（日志实证见 §3.5）。没开 autoRestart 的服务（audiocpp、drama-server、intent-web 等）重启后都停在 FAILED，要手动启。另外，"开机"在这台机器上实际是"**登录后**"：没有配置自动登录。
8. **LSM 的铁律对二狗有直接约束**：项目不许自带任何自启机制，计划任务也不行（ADR-0005）。所以**定时备份不能做成 Windows 计划任务**，只能放在二狗 daemon 内部调度，或者作为 LSM 托管的服务。
9. **华为家庭存储**：装了官方客户端「华为家庭存储」3.0.3.386（MemoSpace）。它通过 Windows Cloud Files 把 NAS 挂成同步根 `C:\吴同学-E898DC\华为家庭存储`（占位符文件，按需下载）。NAS 在局域网的 `192.168.8.5`，客户端走 8464 私有协议，**SMB 445 端口是开的**。没有映射盘符，没有 `net use`，没有保存的凭据。**现有项目没有任何一个往 NAS 备份**。
10. **环境**：Node `v22.23.0`（PATH 上第一个是 pi 自带的 `pi-node`，另有 nvm4w 的 v20.15.1），npm 10.9.8；GPU 是 RTX 4070 Ti 12 GB，驱动 591.86，CUDA 13.1。调研时显存已用 7.3 GB，大头是 Fish。
11. **现场发现的三个 LSM 问题**（与二狗的公网可靠性直接相关）：
    - `agentsense-tunnel` 被 PID 复用骗成 RUNNING，公网实测 502。修复代码已经写好，但常驻管理器是修复之前启动的，没有加载它。
    - `manager.yaml` 里 `vps.key` 路径含控制字符，WebUI 的「开通公网入口」会生成坏的隧道。
    - drama 的 TTS provider 会在 8090 不通时**自己** spawn audiocpp_server，等于有第二个监督者。

---

## 1. audio.cpp

### 1.1 是什么

- `audiocpp_cli` / `audiocpp_server`：一个 ggml 二进制，用本地 GPU 跑 44 个音频模型家族，覆盖 TTS、克隆、voice design、ASR、VC、VAD、说话人分离、分离、音乐生成，"no API and no Python runtime"（`C:\Users\catmaniii\.claude\skills\audio-cpp\SKILL.md:3-9`）。
- 安装形态：官方 Windows 预编译包（`AC/downloads/audiocpp-windows-cuda-balance.zip` + `...-cuda-runtime.zip`）解压到 `AC/dist/cuda/`，exe 时间是 2026-08-03；源码在 `AC/repo`，HEAD 是 `7efbb58`（2026-08-05）。skill 文档记的版本是 release-0.5.1（`.../audio-cpp/references/cli.md:3`）。
- 二进制比源码 README 略旧。我对 `audiocpp_server.exe` 做了字符串检查：`/v1/audio/transcriptions/live`、`voice_presets`、`default_voice_preset`、`busy_timeout_ms`、`/v1/audio/voices`、`stream_format`、SSE 事件名都在；`default_request_options` **不在**，即 README 里"按模型设默认请求参数"这一项用不了。
- 两个 junction：`AC/repo/models → AC/models`，`AC/repo/gpu → AC/dist/cuda`（`AC/run-webui.bat:9-11`）。另有一个 Gradio WebUI（`AC/run-webui.bat`、`run-webui-lan.bat`，Python venv），与服务无关。

### 1.2 实际装了哪些模型

`AC/models/` 实测（skill 里"Currently installed"那节只列了 4 个，已过时，见 `.../references/models.md:87-94`）：

| 目录 | 大小 | 用途 | 备注 |
|---|---:|---|---|
| `Fish-Audio-S2-Pro-GGUF` | 6.0 GB | TTS + 克隆 | **8090 常驻实例当前唯一的模型** |
| `OmniVoice-GGUF` | 1.3 GB | TTS、克隆、`--instruct` voice design，600+ 语言 | 支持（伪）流式 |
| `Chatterbox-GGUF` | 2.0 GB | 克隆、VC，19 语言 | |
| `Supertonic-3-GGUF` | 0.4 GB | TTS，预置音色 M1-M5/F1-F5 | **不支持中文**（`.../references/tasks.md:36`） |
| `Qwen3-ASR-0.6B-GGUF` | 1.1 GB | ASR，支持 offline 和 streaming | drama 用它转写参考音频 |
| `Fun-ASR-Nano-2512-GGUF` | 1.0 GB | ASR，中文最佳，另支持英、日 | 只有 offline |
| `Parakeet-TDT-0.6B-v3-GGUF` | 0.9 GB | ASR，约 35 倍实时 | skill 指明中文要换 fun_asr_nano |
| `Qwen3-ForcedAligner-0.6B-GGUF` | 1.1 GB | 强制对齐 | |
| `HTDemucs-GGUF` / `Mel-Band-RoFormer-GGUF` | 小 | 分离 | |
| `Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF` | **0 B** | — | **空目录**。drama 配的 `vdesModelPath` 指向这里，所以 drama 的"文字描述生成音色"现在会静默失败（`DM/server/providers/tts-audiocpp.js:141-145` 失败返回 null） |
| `Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF` | **0 B** | — | 空目录 |

另外 silero_vad 和 marblenet_vad 随源码自带，不用下载（`.../SKILL.md:88-93`）。

### 1.3 服务形态（当前常驻实例）

- **托管**：`LSM/registry/services/audiocpp.yaml`。
  - `project: drama_maker`，`root: DM`。
  - 探活：`probe.tier: health`，`http://127.0.0.1:8090/health`（7-12 行）。
  - `capabilities: [start, health]`，**没有 stop**，因为二进制不接受停机指令（14-15 行）。
  - 启动钩子：`argv: [node, scripts\audiocpp-serve.mjs]`，`detaches: false`，`readyTimeoutMs: 120000`（28-32 行）。
  - `exposure.never`：用户 2026-09-23 定的"永不上公网"（34-48 行）。
  - 场景：`profiles: [drama]`。
- **配置**：`DM/data/audiocpp-server.json`。
  - `host 127.0.0.1`，`port 8090`，`backend cuda`，`threads 1`。
  - `lazy_load: true`：第一个请求才加载模型，**加载后不会卸载**（`AC/repo/app/server/README.md:77-80`）。
  - `log_request_body: false`。
  - models 只有一项：`{id:"tts", family:"fish_audio", ...fish-audio-s2-pro-q8_0.gguf}`。
- 启动入口 `DM/scripts/audiocpp-serve.mjs`：读 `DM/config/app.config.json` 的 `tts.audiocpp`；server.json 缺失时现造一份（注意它的兜底会把 ASR 也放进去，第 39-42 行，与 drama 的"只放 TTS"纪律矛盾，不过文件已存在，不会走到这条分支）；然后 `spawn(exe, ['--config', ...], {windowsHide:true, stdio:'inherit'})`。
- 运行现场：PID 2016，`audiocpp_server.exe --config DM\data\audiocpp-server.json`，2026-10-05 22:33 起，只绑 127.0.0.1（`netstat` 证实；局域网也连不上，`audiocpp.yaml:39-41`）。日志在 `LSM/logs/audiocpp.out.log`。

### 1.4 HTTP API（`AC/repo/app/server/README.md`）

| 端点 | 用途 | 要点 |
|---|---|---|
| `GET /health` | 就绪 + 已配置模型数 | LSM 用它探活 |
| `GET /v1/models` | OpenAI 风格模型列表 | |
| `POST /v1/audio/speech` | TTS | JSON：`{model, input, voice?, voice_ref?, reference_text?, seed?, max_tokens?, response_format?, stream_format?}`。默认返回 `audio/wav`。`response_format:"json"` 返回 base64 WAV。流式只对 `mode:"streaming"` 的模型有效：`stream_format:"sse"` 推 `speech.audio.delta`（base64 PCM），`stream_format:"audio"` + `response_format:"pcm"` 用 chunked 推裸 PCM（218-259 行） |
| `POST /v1/audio/transcriptions` | ASR | 两种入参：JSON（服务器本地路径），或 OpenAI Whisper 风格的 multipart（`file`/`model`/`language`）。**上传的必须是 WAV**，在内存里解码（274-283 行）。`stream=true` 推 `transcript.text.delta` SSE，但要等整段上传完才开始（285-297 行） |
| `POST /v1/audio/transcriptions/live` | 边录边转 | 请求体是 chunked 裸 PCM，参数走 query（`model`、`sample_rate`、`channels`、`sample_format`），响应是 SSE。README 明说**浏览器驱动不了**（`fetch` 的请求流是半双工），要由 curl/ffmpeg/后端服务来推；经 nginx 时要关请求缓冲（299-369 行） |
| `GET /v1/audio/voices?model=` | 列出缓存音色 id 和服务器端 preset | 361-381 行 |
| `POST /v1/tasks/run` | 通用框架请求 | 字段同 CLI 的 request-sequence（383-399 行） |

其他行为：

- 每个模型的请求在内部锁上串行执行。`busy_timeout_ms` 默认 300000：前一个推理占锁超过这个时长，新请求直接返回 503 `server_busy`（107-128 行）。
- 服务器端可以在配置里写 `voice_presets` / `default_voice_preset`，请求里用 `"voice":"assistant"` 选取（159-194 行）。
- CORS 默认关闭（88-105 行）。

### 1.5 TTS 音色 / timbre 选项

**当前常驻的 Fish Audio S2 Pro**（`AC/repo/docs/tts.md:443-489`、`DM/server/providers/tts-audiocpp.js`）：

- 音色只能靠参考音频克隆：`voice_ref`（WAV 路径）+ `reference_text`。**给了 `voice_ref` 就必须给 `reference_text`**，否则直接报错（`tts-audiocpp.js:7-10`）。不给参考音频就用一个默认嗓音（drama 记作 `fish-default`）。**没有内置音色**（`tts.md:455`）。
- 参考音频要先规范化：44.1 kHz 单声道 PCM WAV，截到 15 s 以内。否则输出"时长跟着参考音频走、内容不对"（`DM/docs/pitfalls.md:487`）。
- 语速：server 不提取 `speaking_rate`，传了也无效。drama 改用 ffmpeg `atempo` 后处理（`tts-audiocpp.js:189-192, 216-241`）。音量同样靠 ffmpeg 后处理。
- 情绪：没有 emotion 参数。在台词里写方括号指令，例如 `[油腻的假笑，慢条斯理]`（`tts-audiocpp.js:172`）。
- 可调的采样参数：`temperature 0.8 / top_k 30 / top_p 0.8 / seed / max_new_tokens`；`text_chunk_size` 默认 200 字（`tts.md:475-489`）。
- 输出格式实测：44.1 kHz、单声道、`pcm_s16le` WAV（用 ffprobe 看了 `user_agent_sense_of_security/output/tts/005f9a9645cdb366.wav`）。
- 语言：模型自动识别，中英文都测过（`tts.md:453`）。

**现成的音色库**：`AC/voices/`。

- 约 60 个参考 WAV，以中文人声为主，例如 `蒋欣.wav`、`安姐.wav`、`年轻乔布斯.wav`，大多配有同名 `.reftext.txt`。
- `voices.json` 是"统一音色库"，drama 读写它（`DM/server/voice-library.js:20-26, 160-168`）。
- agentsense 的演示配音用的是 `output/tts/jiangxin_ref.wav` + `jiangxin_ref.txt`。

**其他可用于中文的家族**（`.../references/models.md:12-35`、`tts.md`）：

| 家族 | 状态 | 中文 | 音色控制 | 流式 |
|---|---|---|---|---|
| `omnivoice` | 已装 | 600+ 语言 | 克隆，或用 `--instruct` 文字描述 | 伪流式（按文本分块推送） |
| `qwen3_tts` Base / VoiceDesign | 未装（目录为空） | 是 | 克隆 / 文字描述；drama 实测 vdes 约 4.25 倍实时、输出 24 kHz（`tts-audiocpp.js:12-16`） | — |
| `index_tts2` | 未装 | 中英 | 克隆 + `--emotion` + `emotion_alpha` | — |
| `voxcpm2` / `confucius4_tts` | 未装 | 是 | 克隆 / 描述 | 支持流式 |
| `supertonic` | 已装 | **否** | 预置 M1-5/F1-5，`speaking_rate` | 支持 |

### 1.6 延迟与显存

本机实测或项目记录：

- Fish 冷加载约 29 s，合成约 1 倍实时（`tts-audiocpp.js:4-5`）。
- agentsense 的录屏脚本写着"audio.cpp 合成慢于实时，现合成会让画面停顿"，还记着"服务和别的项目共用，偶尔会 500：隔几秒重试"（`user_agent_sense_of_security/web/scripts/demo/tts_prep.mjs:2, 56`）。
- skill 记录：Supertonic 约 23 倍实时，Parakeet 约 35 倍，Chatterbox 克隆约 1.5 倍、VC 约 5 倍（`models.md:89-92`）。

上游基准（测试 GPU 未知，`AC/repo/docs/reports/gguf_q8_performance.md:42-49`）：

| 模型（Q8） | 速度（相对实时） | 峰值显存 |
|---|---:|---:|
| Fish | 3.1-3.4 倍 | 7.5-9.2 GB |
| OmniVoice | 8-29 倍 | 约 3.1 GB |
| Qwen3-TTS | 5.8-7.9 倍 | 6.4 GB |

【推测】这台 4070 Ti 上的 Fish 比上游基准慢，原因可能是 `threads:1`、显存吃紧，或者 drama 统计里包含了排队时间。

显存现场：`nvidia-smi` 显示总共 12282 MiB，已用 7333 MiB，Fish 已经被加载。

### 1.7 audio.cpp 能做 STT 吗

能，但**不是 Whisper**。ASR 家族有 `parakeet_tdt`、`qwen3_asr`、`fun_asr_nano`、`voxtral_realtime`、`nemotron_asr`、`vibevoice_asr` 等（`AC/repo/docs/asr.md`），本机装了其中三个（见 §1.2）。源码 docs 里出现 "whisper" 的地方，都只是别的模型内部用到的 Whisper 编码器或预处理配置（`asr.md:135-144`、`docs/models/seed_vc.md:50-64`），**没有 whisper 家族**。

**关键坑**：drama 实测，同一个 server 进程里先跑一次 ASR 再跑 TTS，TTS 会产出噪声（`DM/docs/pitfalls.md:486`、`tts-audiocpp.js:50-54`）。所以 drama 只让 server 托管 TTS，ASR 一律走 CLI 单独进程。

### 1.8 怎么启动；GPU 依赖

- 只能经 LSM 启动：`lsm start audiocpp` 或 `lsm profile drama`。
- 没有 autoRestart：ADR-0004 规定吃 CUDA 的服务不许盲目重拉（`LSM/docs/adr/0004-no-auto-restart-by-default.md:3-8`）。
- 由管理器直接 spawn，所以**管理器一重启它就跟着死**（Task Scheduler 的 job object 会连坐），之后要手动重启（`LSM/docs/adr/0003-detached-processes-with-readoption.md:70-95`）。
- GPU：CUDA 版要求 `cublas64_13.dll` 等运行库放在 exe 旁边（`AC/dist/cuda/README.md`）。也有 CPU 版 `dist\cpu`，按 skill 的说法，CPU 只用于兜底（`SKILL.md:15-16`）。
- **第二个监督者**：drama 的 `ensureServer()` 在 `/health` 不通时会**自己** detached spawn 一个 audiocpp_server，并重写 server.json（`tts-audiocpp.js:71-96`）。这违反 LSM 的 ADR-0005"一个服务只能有一个管理者"。二狗不能照抄。

### 1.9 其他项目怎么调用

| 项目 | 方式 |
|---|---|
| drama_maker | `server/providers/tts-audiocpp.js`：HTTP `POST /v1/audio/speech`，`model:"tts"` + 规范化后的 `voice_ref` + 缓存的 `reference_text`。参考文本用 CLI 跑 `qwen3_asr` 转写一次，缓存成 `<名字>.reftext.txt`。传给 CLI 的路径必须是纯 ASCII，因为 Node 的 `spawnSync` 传中文路径会被破坏（113-115 行） |
| user_agent_sense_of_security | `web/scripts/demo/tts_prep.mjs`：同一个 8090 端点，固定音色"蒋欣"，结果按 md5 缓存成 `output/tts/*.wav`（目前 192 个），失败隔 5 s 重试 3 次 |
| song-to-mv（skill） | 只在 `docs/audio-timing.md:13` 提到可用 Qwen3-ASR + ForcedAligner 做逐字时间戳 |
| bili_video | 不用 audio.cpp，用 faster-whisper（见 §2） |

### 1.10 对二狗的含义【建议】

- 二狗对 8090 做**软依赖**（`dependsOn: [{id: audiocpp, type: soft}]`），不要自己拉起 audio.cpp。音色配置建议存成"音色库 id"（指向 `AC/voices/voices.json` 的条目），每次请求解析成 `voice_ref` + `reference_text`。这样不用改 drama 拥有的 server.json。
- 要明确告诉用户：Fish 不能流式输出，约 1 倍实时，并且和 drama 的批量配音共用一把模型锁（drama 一跑长任务，秘书就可能排队几分钟，或者拿到 503）。
- 如果想要"秘书边想边说"，需要按句切分 LLM 输出、逐句合成、逐句播放。或者另起一个专属 TTS 实例（例如 OmniVoice，约 3 GB 显存，支持伪流式），但这会和 Fish 抢 12 GB 显存。

---

## 2. Whisper / 本地 STT

### 2.1 结论

**本机没有部署任何 Whisper 服务**：

- 没有监听端口的 whisper 进程（端口表见附录 B）。
- `whisper*` 命令不在 PATH 上。
- LSM 注册表里没有。

Whisper 相关的东西只有"库 + 权重 + 一次性脚本"。

### 2.2 盘点

| 资产 | 位置 | 状态 |
|---|---|---|
| faster-whisper 1.2.1 + ctranslate2 4.8.1（torch 2.6.0+cpu） | 全局 Python 3.11.9（Microsoft Store 版，`...\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\python.exe`） | 能 import |
| 权重 | `C:\Users\catmaniii\.cache\huggingface\hub\models--Systran--faster-whisper-large-v3`（2.9 GB）、`-small`（464 MB）、`-tiny`（75 MB） | 已缓存 |
| 使用者 | `D:\code\claudecode\bili_video\*.py`（`transcribe.py`、`hcp_transcribe.py`、`liao_transcribe.py`、`scope_all.py`、`fix_lang.py`）、`reasoning_graph_patent\mv\audio\lyrics_align.py` | 都是 `WhisperModel("large-v3", device="cuda", compute_type="float16")` 的离线批处理 |
| FunASR | `D:\code\claudecode\vibecraft\.venv`（funasr、torch、modelscope 都在）；模型在 `C:\Users\catmaniii\.cache\modelscope\hub\models\iic\`（SenseVoiceSmall、paraformer 流式、seaco-paraformer） | 嵌在 vibecraft 进程里，不是独立服务 |
| audio.cpp ASR | Qwen3-ASR-0.6B、Fun-ASR-Nano、Parakeet（§1.2） | 可以起成 server，目前没起 |
| whisper-tiny | `E:\ComfyUI-aki-v3\ComfyUI\models\sonic\whisper-tiny` | Sonic 插件内部用，和 STT 无关 |

### 2.3 中文表现与流式（本机经验 + 文档）

- **faster-whisper large-v3**：bili_video 拿它转写了多场中文学术报告，元数据里有"语种自动判定为中文（置信度 0.98）"（`bili_video/hcp_fix_and_pack.py:265`）。项目里留下的经验有三条：
  - 用中文 `initial_prompt` 给术语表（`hcp_transcribe.py:14-18`）；
  - 配 `vad_filter` + `condition_on_previous_text=False`；
  - 会误判语种，`fix_lang.py` 就是为了"强制指定语种重转个别误判的报告"而写的。
  
  环境方面：ctranslate2 偶发 DLL 占用（WinError 32），需要重试 import（`hcp_transcribe.py:4-5, 24-37`）；PyAV 的 DLL 加载失败，要绕开（`lyrics_align.py:4`）。Whisper **原生不流式**。【推测】large-v3 fp16 约占 3-4.5 GB 显存，和已加载的 Fish 同时在卡上会很紧。
- **Fun-ASR-Nano**（audio.cpp）：skill 标为"Best for Chinese"，只有 offline，不出时间戳（`models.md:43`、`asr.md:26-40`）。
- **Qwen3-ASR**（audio.cpp）：支持 offline 和 streaming，streaming 模式按块输出缓冲后的 delta（`asr.md:44-53`）。drama 用 0.6B 转写中文参考音频。
- **FunASR paraformer-zh-streaming**（vibecraft）：真流式，600 ms 一块，可配中文热词；CPU 推理；手机按住说话、松手发送（`vibecraft/src/vibecraft/server/asr.py:1-66`、`vibecraft/docs/voice-input-runbook.md`）。
- **浏览器侧的事实**：`getUserMedia` 只在 HTTPS 下可用，局域网 http 用不了麦克风（`voice-input-runbook.md:36-37, 59`）。vibecraft 的做法是用 AudioWorklet 采集 16 kHz PCM16，每帧 100 ms，经 WebSocket 发给服务端（`asr.py:333-341`）。audio.cpp 的 multipart 只认 WAV；浏览器 MediaRecorder 默认产出 webm/opus，要服务端用 ffmpeg 转（ffmpeg 在 PATH：`C:\ffmpeg-2024-10-21-git-baa23e40c1-full_build\bin\ffmpeg.exe`）。

### 2.4 二狗的可选路线【建议】

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. audio.cpp ASR 第二实例 | 另起 `audiocpp_server`（如 `127.0.0.1:8091`），models 只放 `qwen3_asr`（mode: streaming）或 `fun_asr_nano`；LSM 新增一个条目 | 无 Python；OpenAI 兼容；`/live` 端点能让 daemon 一边收浏览器 PCM 一边转发；守住"ASR 和 TTS 不同进程"的纪律 | 再占约 1-2 GB 显存（【推测】）；streaming 只有 qwen3_asr 有；严格说不是 Whisper |
| B. faster-whisper 小服务 | 写一个 Python HTTP 包装（OpenAI 兼容 `/v1/audio/transcriptions`），加载 large-v3，`int8_float16` 节省显存，交给 LSM 托管 | 就是用户说的 "Whisper"；库和权重都已就绪 | 要新写服务；原生不流式；有语种误判和幻听风险；依赖全局 Store Python（不稳） |
| C. 复用 FunASR | 从 vibecraft 抽出 paraformer-zh-streaming，做成独立服务 | 真流式；中文和热词都好；CPU，不抢 GPU | 要搬依赖（torch、funasr 体量 GB 级）；不是 Whisper |

用户说的 "Whisper" 可能是泛指"本地语音识别"，需要确认（见 §6）。

---

## 3. 本地服务管理器（LSM）

### 3.1 架构

- **定位**：开发机上所有常驻服务的唯一管理者。只管"活没活、要不要重启"，不管业务（`LSM/README.md:1-4`）。
- **进程**：`node bin\lsm.mjs serve`。HTTP + WebSocket 绑 `127.0.0.1:7420`（`LSM/registry/manager.yaml:2-3`）。每 5 s 一轮探活，每 60 s 一轮哨兵和公网实测（`LSM/src/server.mjs:123-142`）。启动时先 listen 再重认领（146-153 行）。
- **模块**：
  - `src/registry.mjs`：加载并校验 YAML；
  - `src/supervisor.mjs`：状态机、编排、autoRestart、公网开通；
  - `src/hooks.mjs`：钩子执行、spawn；
  - `src/probe.mjs`：四档探活 + 身份校验；
  - `src/link.mjs`：接入协议；
  - `src/exposure.mjs`：公网可达性；
  - `src/sentinel.mjs`：端口哨兵 + 计划任务哨兵；
  - `src/autostart.mjs`：LSM 自己的计划任务；
  - `src/auth.mjs`：SCRAM，目前没开。
- **数据**：
  - `registry/manager.yaml` + `registry/services/<id>.yaml`：真理源，一服务一文件（ADR-0002）；
  - `state.json`：账本，易失；
  - `logs/manager.log`、`logs/audit.log`、`logs/<id>.out.log`。
- **核心原则**（README 里 ADR 速览，`LSM/README.md:33-48`）：
  - 启停由项目钩子实现；
  - 服务是脱离的孤儿进程，用 PID + 启动时间 + 端口三元校验重认领；
  - 默认不自动重启；
  - 排他托管；
  - 端口就是身份；
  - 只用哨兵发现，不强制阻止；
  - GPU 独占，所以按"场景"分组；
  - 不替项目伪造它没有的能力；
  - 接入层协议。
- **状态机**：STOPPED / STARTING / RUNNING / DEGRADED / STOPPING / FAILED / ORPHAN / EXTERNAL（`LSM/docs/service-schema.md:122-133`）。
- **CLI**：`status / validate / start / stop [--when-idle|--force] / restart / profile / profile-stop / orphan / reload / scan / detach-task / serve / install-autostart / install-shortcut / auto-open`。管理器在跑时，CLI 命令走 HTTP 交给它执行；不在时退回本地直连（`LSM/bin/lsm.mjs:141-159, 204-224`）。

### 3.2 怎么注册一个服务（`LSM/docs/service-schema.md:18-99`、`LSM/src/registry.mjs:99-124`）

| 字段 | 说明 |
|---|---|
| `id` / `name` / `project` / `root` | `id` 必须等于文件名；`root` 是所有钩子的工作目录，必须存在 |
| `kind` | `managed`（生死归管理器）或 `external`（只探活） |
| `role` | `tunnel`：纯隧道，WebUI 不单独占卡片 |
| `probe` | `tier`: process / port / health / linked。port/health/linked 档必须有 `port`；health 档要 `health.url` + `timeoutMs`；process 档要 `pidFile`、`matchCmd` 或 `detaches:false` 三选一；`extraPorts` 登记附属端口 |
| `capabilities` | `start/stop/restart/health/busy`，只写真有的，没写的在 WebUI 上灰显（ADR-0011） |
| `link.enabled` | spawn 时注入 `LSM_URL / LSM_SERVICE_ID / LSM_TOKEN / LSM_PROTOCOL`（`supervisor.mjs:213-223`） |
| `hooks.start/stop/restart` | `cmd`（字符串，经 shell）或 `argv`（数组，不经 shell，**唯一能做到零窗口**的形式）；`detaches`（false = 管理器直接 spawn，stdout 落到 `logs/<id>.out.log`）；`timeoutMs`、`readyTimeoutMs`、`idleTimeoutMs` |
| `env` | 只声明来源，不存值：`userEnv`（每次执行现读用户环境变量）/ `file`（相对 root）/ `literal`（只允许非敏感值）。钩子拿到的是最小基础环境加上这里声明的变量，不继承管理器的整份 env（`hooks.mjs:10-49`） |
| `logs` | 管理器只 tail，不采集 |
| `exposure` | `via` 隧道 id + `remotePort` + `publicUrl` + `check`；或 `never: <原因>`，二者互斥 |
| `dependsOn` | `{id, type: hard|soft}`。hard = 等它就绪再启，起不来整条链失败；soft = 不等，只标记降级。保存注册表时就检测循环依赖 |
| `autoRestart` | `enabled`（默认 false）/ `maxRetries` / `backoffMs`。每轮按**状态**评估，不按状态跳变触发（ADR-0004 补记） |
| `profiles` | 所属场景 |
| `onboarding` | 纳管留痕：摘除了哪些计划任务、验证时间、验证过哪些钩子 |

**钩子硬约定**（`service-schema.md:101-120`）：

1. 退出码 0 表示成功；
2. 超时算失败，管理器 `taskkill /T /F` 并转 FAILED，不重试；
3. 工作目录恒为 `root`；
4. 禁止交互，stdin 是 ignore，PowerShell `ReadKey` 也不许有；
5. 必须幂等；
6. `stop` 必须真的停下；
7. 缺失的能力就是缺失；
8. Windows 没有 SIGTERM，优雅停机只能靠服务自己的带内通道。

**接入协议 v1**（`LSM/docs/link-protocol.md`）：

- 服务出站连接 `ws://127.0.0.1:7420/link`，带 Bearer token。
- 消息：`hello`（上报能力）、5 s 一次的 `heartbeat`（health、busy、busyReason）、对指令的 `ack`、退出前的 `bye`。管理器下发 `stop/restart`（mode 为 now 或 when-idle）、`cancel`、`ping`、`conflict`。
- 没注入身份时必须静默跳过（铁律）。
- 现成客户端：`LSM/clients/lsm-link.mjs`（Node，零依赖），样板是 `LSM/examples/demo-service.mjs`。
- 管理器 15 s 收不到心跳，只把探活降回 port/health 档，不判死。

### 3.3 WebUI 功能（`LSM/docs/webui.md`、`LSM/webui/index.html`）

- 单页，无构建步骤，原生 ESM + 一条 `/ws` 推送，只绑本机。目前**没有公网隧道**，`auth.enabled: false`（`manager.yaml:40-42`）。
- 顶部统计条；哨兵横幅（未纳管的端口、该摘的计划任务），可以一键进入纳管或摘除。
- **场景**区：一键按依赖拓扑启动整组服务。
- **服务卡片**：
  - 状态灯旁标探活档位；
  - busy 状态单独显示；
  - 本地 / 局域网 / 公网三种入口 URL，只有绑 0.0.0.0 才给局域网地址；
  - 公网链路图：隧道进程是否在跑，和公网实测是否通，分开显示；
  - 依赖关系；
  - 最近日志 + 按需打开的 tail 流（经过脱敏）。
- **操作**：启动、停止、重启、等空闲后再停/再重启、取消停机、强制 kill（藏在二级菜单）、场景启停、接通/断开公网、开通公网入口、处理孤儿、摘除自启任务（`index.html:466-467, 568-593`）。所有写操作都记审计日志。
- **没有**"开机自启"开关，也没有定时任务（cron）这一概念。

### 3.4 公网隧道与 VPS nginx

- **本机侧**：隧道本身也是一个托管服务。以 `LSM/registry/services/agentsense-tunnel.yaml` 为例：
  - `role: tunnel`；
  - `probe.tier: process` + `matchCmd: 18797:127\.0\.0\.1:8797`；
  - `capabilities: [start]`；
  - `argv` 直接起 Windows 自带的 OpenSSH：`ssh -i D:\code\claudecode\vibecraft\.secrets\ali-cloud-hk-...pem -N -n -T -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -R 127.0.0.1:18797:127.0.0.1:8797 root@47.76.87.213`；
  - 重连交给 `autoRestart`（maxRetries 20，退避 5/15/60 s）（17-41 行）。
- **被暴露的服务**：在 `exposure` 里声明 `via`、`remotePort`、`publicUrl`、`check: true`。管理器每 60 s 去打一次 publicUrl：401/403 也算通，5xx 或超时算不通（`agentsense-web.yaml:42-47`、`LSM/src/exposure.mjs:48-70`）。
- **VPS 侧**：`root@47.76.87.213`（从密钥名看是阿里云香港），域名一律用 `<名字>.47.76.87.213.sslip.io`。
  - nginx 在 443 上用 stream `ssl_preread` 按 SNI 分流：`turn.*` 去 coturn，其余默认落到 `127.0.0.1:8443`，再由各站点的 `server_name` 选中（`vibecraft/README.md:323-325, 409`；`intent-mining/site/deploy/intent.conf:1-3`）。
  - 每个站点一个 `sites-enabled/<名字>.conf`，`listen 127.0.0.1:8443 ssl`，`proxy_pass http://127.0.0.1:<remotePort>`，证书是 Let's Encrypt。签发方式有两种：certbot webroot（`-w /var/www/acme`，由 :80 上的 turn-testpage 放行挑战）和 standalone + pre/post 钩子（`intent.conf:11-32`、`agentsense-tunnel.yaml:49-50`）。
  - 已有站点的 nginx 源文件**只有 `intent.conf` 留在了 PC 的仓库里**，其他站点只在 VPS 上有。
- **边界**：管理器只在本机起 ssh，**从不改 VPS**。WebUI 的「开通公网入口」会生成隧道 YAML 和一段要你自己贴上去的 nginx 片段（`supervisor.mjs:555-654`、`LSM/docs/adr/0009-webui-auth-and-exposure.md:16-20`）。2026-09-01 有过一次经用户明确授权的例外（sts2）。

### 3.5 自启现状

- **LSM 自身**：计划任务 `LocalServiceManager`，State=Running，以 `catmaniii` 身份 Interactive 运行。动作是 `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& 'C:\Users\catmaniii\AppData\Local\pi-node\current\node.exe' 'LSM\bin\lsm.mjs' serve"`。两个触发器：**登录时**一次，外加每 5 分钟重复（看门狗，`MultipleInstances=IgnoreNew`）；`RestartCount 3 / 1 min`（`LSM/src/autostart.mjs:12-41`、`Get-ScheduledTask` 实测）。`LastTaskResult=0x800710E0` 是看门狗触发被 IgnoreNew 丢弃时的正常结果。
- **故意不做成 Windows 服务**：Session 0 看不见桌面（vibecraft 要抓画面），会让它起的所有子进程都继承隔离（`autostart.mjs:1-3`、ADR-0003 第 15-23 行）。
- **"开机"实际上是"登录后"**：`Winlogon\AutoAdminLogon` 没有设置。上次启动是 2026-10-05 22:19:25，管理器 22:19:51 起来，说明用户当时很快就登录了。无人值守的重启（比如夜间 Windows 更新）之后，在用户登录前什么都不会起来。【推测】Windows 更新后的 ARSO 自动登录可能部分覆盖这种情况，未核实。
- **按服务的开机自启：不存在**。但重启后有一个事实上的近似，管理器日志里有实证（`LSM/logs/manager.log`，2026-10-05T14:19Z 那次重启）：
  1. 14:19:51 管理器就绪；14:19:53 "重认领完成：12 个服务在跑"。这是第一轮的宽限期在作怪，账本上的旧 RUNNING 还没被推翻（`supervisor.mjs:17-35`）。
  2. 14:19:57 所有服务转 FAILED。**开了 `autoRestart` 的**——agentsense-web、四条隧道、vibe-ide-hub、vibe-ide-runner——3-5 s 后被重拉，14:20:22 前全部 RUNNING。
  3. **没开 autoRestart 的**——audiocpp、drama-server、intent-web、rg-lean-serve——一直停在 FAILED，直到被手动启动：前三个在 14:33-14:34，rg-lean-serve 在 14:59。
  
  也就是说，现在"重启机器后会自己回来"的充要条件是 `autoRestart.enabled` 且账本里 `desired=running`。这把"崩溃后重启"和"开机启动"两件事混在了一起，而 ADR-0004 又禁止吃 CUDA 的服务开 autoRestart。
- **LSM 之外的自启残留**（计划任务哨兵应该能看到）：`IndexTTS-WSL-Autostart`、`SpireBotSupervisorOnce`。

### 3.6 二狗要被托管，需要提供什么【建议】

参考 `agentsense-web.yaml` 和 `intent-web.yaml`（linked 档样板）：

1. **`ergou-daemon.yaml`**
   - `root: D:\code\claudecode\my_personal_agent_ergou`。
   - `probe.tier: linked`，或 health + 一个**无需鉴权、真实反映健康**的 `/healthz`。
   - `port` 选一个没被占用的（附录 B 列了已占用端口）。
   - `hooks.start.argv: [node, <入口>]`，`detaches: false`；`capabilities` 只写真有的。
   - `link.enabled: true`，接入 `clients/lsm-link.mjs`：长程任务进行中就上报 `busy`，这样 `stop --when-idle` 才有意义。
   - `env` 用 `userEnv` 或 `file` 声明 API key。
   - `autoRestart` 可以开，二狗不吃 CUDA。
   - `dependsOn: [{id: audiocpp, type: soft}]`（以及 ASR 实例，也是 soft）。
   - `exposure.via: ergou-tunnel`；`profiles: [ergou]`。
2. **`ergou-tunnel.yaml`**：照抄 `agentsense-tunnel.yaml`，换端口；remotePort 选一个没被占用的（附录 B）。**密钥路径照抄现有隧道里的写法，不要用 `manager.yaml` 里的**（见 §3.8）。
3. **（可选）`ergou-asr.yaml`**：路线 A 的第二个 audiocpp_server 实例，`exposure.never`。
4. **VPS nginx 站点**（用户自己贴，或者明确授权后代办）：
   - 新增 `server_name ergou.47.76.87.213.sslip.io` + 证书；
   - 要支持 WebSocket（`Upgrade`/`Connection` 头），`proxy_read_timeout` 要够长；
   - 语音上传要放大 `client_max_body_size`（intent.conf 只有 1m）；
   - 若做流式音频，按 audio.cpp README 关闭 `proxy_buffering` 和 `proxy_request_buffering`。
   
   另外，公网暴露的二狗必须有自己的鉴权。
5. **二狗项目里不许有任何自启机制**（计划任务、Run 键、`while($true)` 重启循环都不行，ADR-0005）。定时备份因此也不能是 Windows 计划任务，见 §4.3。
6. **要接受的事实**：LSM 每次重启，二狗 daemon 都会被 job object 连坐杀掉（ADR-0003 的 2026-08-29 修正）。二狗的状态必须扛得住突然被 kill：对话和任务持久化落盘，启动时能恢复。

### 3.7 实现"按服务开机自启"要动哪些地方【建议】

- **数据放在哪**（先做决策）：
  - 方案一：在每个服务的 YAML 里加 `autostart: true`。registry 是真理源（ADR-0002），但 WebUI 要切换就得改写带注释的 YAML。现有先例 `createExposure` 只用追加的方式写（`supervisor.mjs:616-628`），关掉则需要真正编辑。
  - 方案二：在 `manager.yaml` 加一个列表，例如 `autostart: [ergou-daemon, ergou-tunnel]`，或者约定一个名叫 `boot` 的场景。这样能直接复用 `startProfile` 的拓扑启动逻辑。
- **`src/registry.mjs`**：目前加载时**逐字段重建** svc 对象，未知字段会被静默丢掉（99-124 行）。需要解析新字段，并在 `validate()` 里校验：必须是 managed、必须有 start 能力，以及它的 hard 依赖也要能启动。
- **`src/supervisor.mjs` / `src/server.mjs`**：`serve()` 在 `adopt()` 之后（`server.mjs:152`）新增一个 boot 阶段。用 `topoLayers` 分层，对自启集合里还不在 RUNNING 的服务调用 `start()`。要决定的语义：
  - 用户关机前手动 stop 过的服务（`desired=stopped`），开机还拉不拉？
  - 只在"机器刚启动"时做（比较 `Win32_OperatingSystem.LastBootUpTime` 和 `state.manager.startedAt`），还是每次管理器启动都做？后者更合理，因为 `detaches:false` 的子进程会随管理器重启一起死。
  - 和 `autoRestart`（崩溃重拉）、`retries` 计数（会落盘）怎么分工。
  - GPU 场景冲突（ADR-0010）：对 audiocpp 这类服务开自启，要考虑 `lazy_load` 的特点——启动不占显存，第一次使用后常驻显存、不释放。
  - hard 依赖会被 `ensureDeps` 连带拉起（`supervisor.mjs:225-247`），这可能把 GPU 服务也带起来。
- **API / CLI / WebUI**：
  - `server.mjs` 的 `runAction` 加 `autostart-on/off`（173-199 行），并记审计日志；
  - `snapshotForUi()` 输出 autostart 标记；
  - `bin/lsm.mjs` 加命令和状态列；
  - `webui/index.html` 在卡片上加开关和徽标。
- **LSM 自身的触发器**（`src/autostart.mjs`）：现在是 AtLogOn。想做到真正的"开机即在线"，要么配置自动登录（安全取舍要用户拍板），要么改成开机触发，但开机触发跑在 Session 0，与 ADR-0003 冲突。
- **文档和测试**：新增一份 ADR，写清与 0004/0005/0010 的关系；更新 `docs/service-schema.md`、`README.md`、`~/.claude/skills/local-service-manager/SKILL.md`（纳管时加一问"要不要开机自启"）；在 `tests/unit.test.mjs` 加回归测试。

### 3.8 现场发现的问题（都没修，只记录）

1. **agentsense 公网 502，管理器却以为隧道在跑**。`state.json` 记着 `agentsense-tunnel` RUNNING，pid 2344，但实测 2344 是 `svchost.exe`；全机的 ssh 进程里没有 `-R ...18797`；`https://agentsense.47.76.87.213.sslip.io/healthz` 实测返回 502。这正是 ADR-0003 2026-10-05 补记里描述的 PID 复用毒化（`LSM/docs/adr/0003-detached-processes-with-readoption.md:97-116`），修复在 `src/probe.mjs` 的 `verifyIdentity`。但常驻管理器（PID 11104）是 **2026-10-05 22:19:51 启动的，早于修复写入的 23:13-23:16**，还在跑旧代码。要重启 LSM 才能生效。重启会连带杀掉 audiocpp 和各条隧道：隧道会自动回来，audiocpp 要手动启。
2. **`manager.yaml` 的 `vps.key` 路径坏了**：原始字节是 `D:\code\claudecode<0x0B>ibecraft\.secrets<0x07>li-cloud-...pem`，`\v` 和 `\a` 被当成转义字符写进了文件（`LSM/registry/manager.yaml:38`）。WebUI「开通公网入口」用这个值生成 `ssh -i`（`supervisor.mjs:580-585`），隧道会起不来。现有的各条隧道 YAML 里写死的是正确路径，所以不受影响。
3. **audiocpp 有第二个监督者**：见 §1.8，drama 的 `ensureServer()` 会自己 spawn。

---

## 4. 华为家庭存储

### 4.1 怎么挂载 / 怎么寻址（只看了挂载方式，没读内容）

- 客户端：已安装「华为家庭存储」3.0.3.386，发布者 Huawei Technologies，路径 `C:\Program Files\Huawei\MemoSpace\`（注册表 Uninstall 项 `MemoSpace`）。正在运行 `MemoSpace.exe`、`SpaceSync\MemoSpaceSync.exe`、`SpaceSync\SyncApp.exe`。
- **挂载方式是 Windows Cloud Files 同步根，不是盘符**：
  - `HKLM\...\Explorer\SyncRootManager\MemoSyncFileProvider!<SID>!MemoSyncFileAccount`，显示名"华为家庭存储"；
  - `UserSyncRoots` 指向 `C:\吴同学-E898DC\华为家庭存储`，该目录属性是 `Directory, ReparsePoint`，即占位符目录，文件按需下载；
  - 资源管理器左侧有对应的命名空间项。
  - 【推测】设备型号是 AS6020：同步根注册里的回收站帮助链接含 `AS6020-02`。
- **NAS 地址**：本机 `192.168.8.4/24`，网关 `192.168.8.1`。`MemoSpaceSync` 与 `192.168.8.5:8464` 保持着 4 条连接，所以 NAS 是 `192.168.8.5`。轻量端口探测结果：**445（SMB）开着**，8464 开着，139/80/443/22/5005 都不通。反向 DNS 和 NetBIOS 都没有名字，所以只能用 IP 寻址；【推测】是 DHCP 分配的地址，可能会变。
- **没有** SMB 映射：`Get-PSDrive` 只有 C/D/E；`net use` 为空；`Get-SmbMapping` 为空；`cmdkey /list` 里没有 192.168.x、huawei、nas 相关的凭据。

### 4.2 现有项目是否已经在备份

**没有**：

- 全量搜索 `D:\code\claudecode`（关键词：华为家庭存储、HomeStorage、robocopy、`\\192.168`、smb://、备份到 NAS）没有任何命中。
- 非系统计划任务里没有备份类任务。
- 项目里的"备份"都是本地的：drama 在迁移前把 `drama.db` 复制到 `data/backups/`（`DM/server/index.js:568`）；脚本写盘前把文件备份到 `tmp/`。

### 4.3 对二狗的含义【建议】

- **调度**：ADR-0005 不允许项目自带计划任务，LSM 也没有 cron 概念。所以备份调度应当放在二狗 daemon 内部，例如每天定点执行，记录上次成功时间，错过就补跑，失败时由秘书告诉用户。
- **目标有两条路**：
  - **SMB 直写**：`\\192.168.8.5\<共享名>`。需要用户在家庭存储里确认或开启 SMB 共享、给一个账号，凭据放 `.secrets/` 或 Windows 凭据管理器，由 LSM 的 `env.from: file` 注入。这条路可以做带版本的快照目录。
  - **写进同步根** `C:\吴同学-E898DC\华为家庭存储\...`，靠客户端上传。依赖客户端在用户会话里运行，而且同步语义（删除是否会同步过去、有没有冲突副本）不等于备份。不推荐把它当唯一的备份路径。
- **数据库**：drama 已经在用 `node:sqlite` 的 `DatabaseSync`（`DM/server/db/db.js:2-7`）。二狗如果也用 SQLite，备份要用在线一致快照（`VACUUM INTO`，或者 Node 22.16+ 的 `sqlite.backup()`。【推测】后者在 22.23 上可用，未实测），不要直接复制正在写的库文件和 WAL。

---

## 5. Node.js 与 GPU

- `node -v` = **v22.23.0**。PATH 上第一个 node 是 `C:\Users\catmaniii\AppData\Local\pi-node\current\node.exe`，这是 pi 自带的 node，里面装着 `@earendil-works/pi-coding-agent@0.84.1`。另有 `C:\nvm4w\nodejs\node.exe` = v20.15.1。npm 10.9.8。PATH 开头有未展开的 `%NVM_HOME%` 和 `%NVM_SYMLINK%`。LSM 自己用 pi-node 的 node 运行；钩子里写 `argv: [node, ...]` 时，按管理器启动时快照的 PATH 解析。【建议】二狗的钩子写死 node 的绝对路径，避免哪天 PATH 顺序变了换成 v20。
- **GPU**：NVIDIA GeForce RTX 4070 Ti，12282 MiB，WDDM，驱动 591.86，CUDA 13.1，compute capability 8.9。调研时已用 7333 MiB，GPU 进程有 `audiocpp_server.exe`，以及 Chrome、ToDesk、DevEco 等 C+G 进程。
- **其他依赖**：ffmpeg 在 PATH 上（2024-10-21 full build）；OpenSSH_for_Windows 9.5p2。
- **还会吃 GPU 的**：ComfyUI（E 盘）、vibecraft（SC2）、faster-whisper 批处理。LSM 用"场景"来避免它们同时运行（ADR-0010）。

---

## 6. 开放问题

1. **"本地 Whisper"是指 Whisper 这个模型，还是泛指本地语音识别？** 如果允许不是 Whisper，audio.cpp 的 Qwen3-ASR 或 Fun-ASR-Nano 第二实例，以及 FunASR，都比新搭一个 faster-whisper 服务省事，中文也更强。
2. **语音输入要"按住说话、松手出整句"，还是要边说边出字？** 后者只有 qwen3_asr（audio.cpp）和 paraformer-zh-streaming（FunASR）能做，而且 `/live` 端点必须由二狗 daemon 中转（浏览器 → WebSocket → daemon → chunked PCM）。
3. **秘书说话的延迟目标是多少？** Fish 约 1 倍实时、不支持流式、和 drama 共用一把锁。可以接受"整句合成完再播"吗？要不要为秘书单独起一个 TTS 实例（OmniVoice 约 3 GB 显存，支持伪流式）？那样会和 Fish、ComfyUI 抢显存。
4. **秘书的默认音色用哪个？** 用 `AC/voices` 里现成的，还是要录一段新的？如果用 voice design（Qwen3 VoiceDesign），需要先补下载，那个目录现在是空的。
5. **"开机自启"是否接受"登录后才自启"？** 要不要开启 Windows 自动登录？这涉及安全取舍。
6. **自启开关放在哪：每个服务的 YAML，还是 manager.yaml 的列表或 `boot` 场景？** 用户手动停过的服务，开机还拉不拉？audiocpp 要不要也开自启，以保证秘书开机就能说话？
7. **LSM 当前的两个问题**（agentsense 隧道误判 + 旧代码在跑、`vps.key` 坏路径）由谁、什么时候修？修第一个要重启 LSM，会中断 audiocpp。
8. **NAS 侧**：能否开启 SMB 共享并给二狗一个专用账号？共享名是什么？要不要在路由器上把 `192.168.8.5` 固定成 DHCP 保留地址？备份保留多少份、多久一次？NAS 不在线时怎么提醒用户？
9. **VPS nginx 站点**：二狗的站点由用户自己贴，还是授权代办（ADR-0009 默认不改 VPS）？
10. **drama 的 `ensureServer()` 自行 spawn audiocpp**：要不要顺手提给 drama，改成只依赖 LSM？

---

## 附录 A：主要证据文件

| 主题 | 文件 |
|---|---|
| audio.cpp skill | `C:\Users\catmaniii\.claude\skills\audio-cpp\SKILL.md`、`references\{cli,models,tasks}.md` |
| audio.cpp server API | `D:\code\claudecode\audio.cpp\repo\app\server\README.md` |
| TTS/ASR 文档与性能 | `audio.cpp\repo\docs\tts.md`、`asr.md`、`reports\gguf_q8_performance.md`、`reports\asr_test.md` |
| 常驻实例配置与入口 | `drama_maker\data\audiocpp-server.json`、`drama_maker\scripts\audiocpp-serve.mjs`、`drama_maker\config\app.config.json`（只读了 `tts` 段） |
| 调用方 | `drama_maker\server\providers\tts-audiocpp.js`、`drama_maker\server\voice-library.js`、`user_agent_sense_of_security\web\scripts\demo\tts_prep.mjs` |
| 踩坑记录 | `drama_maker\docs\pitfalls.md:484-488` |
| Whisper / FunASR | `bili_video\{transcribe,hcp_transcribe,fix_lang}.py`、`reasoning_graph_patent\mv\audio\lyrics_align.py`、`vibecraft\src\vibecraft\server\asr.py`、`vibecraft\docs\voice-input-runbook.md` |
| LSM | `local_service_manager\{README,CONTEXT}.md`、`docs\service-schema.md`、`docs\link-protocol.md`、`docs\webui.md`、`docs\adr\0003,0004,0005,0009`、`src\{supervisor,server,registry,hooks,exposure,autostart}.mjs`、`registry\manager.yaml`、`registry\services\{audiocpp,agentsense-web,agentsense-tunnel,intent-web}.yaml`、`state.json`、`logs\manager.log`、`logs\audiocpp.out.log` |
| LSM skill | `C:\Users\catmaniii\.claude\skills\local-service-manager\SKILL.md` |
| VPS nginx 样例 | `intent-mining\site\deploy\intent.conf` |

## 附录 B：端口占用（2026-10-07 实测 + 注册表）

- **本机监听**：
  - 3080 / 3081（dsh，已停）
  - 7331（rg-lean）、7332（intent-web）、7420（LSM）、7500（sts2）、7999（link-demo）
  - 8080 / 8081（vibecraft + 信令，已停）、8083（index-tts2 WSL，drama 配置）
  - 8090（audiocpp）、8710（hdc）、8770（spirebot）、8787 / 8788（vibe-ide）、8795（rh-webui）、8797（agentsense）、8799（drama）
- **VPS remotePort**：17500、18080、18081、18082、18083、18084、18770、18790、18797、18799。
