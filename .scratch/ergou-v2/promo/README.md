# 二狗宣传片

| 目录 / 文件 | 放什么 | 进不进 git |
|---|---|---|
| `scripts/` | 历版脚本。**现在用的是 `video-script-v4.md`**；v1–v3 留作历史 | 进 |
| `video/` | 制作目录：分镜 `storyboard.json`、渲染代码 `render/`、工具 `tools/` | 分镜和代码可以进，目前没提交 |
| `video/audio/` | 配乐、配音、参考声音 | 不进（`.gitignore` 排除） |
| `video/assets/` | 录屏、截图等素材 | 不进 |
| `video/out/` | 预览、成片、联系表、对比图 | 不进 |

## 现在定下的（2026-10-14）

- **宣传语**：越懂你，越放心。
- **配乐**：`video/audio/music-v4-B.mp3`（Suno 免费版生成，3:10，纯音乐）。Suno 免费版的作品不能商用。
- **声音**：

  | 角色 | 声音 | 文件 / 来源 |
  |---|---|---|
  | 二狗（秘书，也是片中各项目负责人说话时用的声音） | 灿灿的远（克隆真人参考音色，用户保留） | `D:\code\claudecode\audio.cpp\voices\灿灿的远.wav` |
  | 你（片中的用户） | 30 岁男声，随意口语 | `video/audio/voices/用户-设计A.wav`（OmniVoice 设计） |
  | 旁白（讲故事的人） | 知性成熟女声 | `video/audio/voices/旁白-设计C.wav`（OmniVoice 设计） |
  | 二狗换了音色之后（演示"声音你来定"） | 20 岁女声 | `video/audio/voices/换声音-设计A.wav`（OmniVoice 设计） |

  三段设计出来的声音，生成参数写在 `video/audio/voices/README.txt` 里。正式配音时拿这几段当参考音频去克隆，保证全片同一个声音。
- **真实数据卡**：第三幕放一张"真实项目"卡，内容是"内存行情台首版：247 次操作，你只点了 7 次；自动拉回 5 次"。数字是 2026-10-14 从本机数据只读统计的。
- **制作流程**：照 `song-to-mv` skill；配乐照 `suno-compose` skill。
