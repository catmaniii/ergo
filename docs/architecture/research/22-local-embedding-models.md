# 调研 22：本地语义检索用的向量模型——有没有比 bge-m3 更好的

> - **调研日期**：2026-10-20（星期二）。只读一手资料：Hugging Face 模型卡和文件清单（HF API）、arXiv 论文、MTEB 官方结果仓库、transformers.js 4.3.1 发布包源码（unpkg）和官方文档。**没有下载、安装、运行任何模型**，没有跑 npm 或 pip，没有改二狗的代码。所以本文所有"速度""内存"都没有实测。
> - **问题**：二狗现在用量化版 bge-m3 做素材的语义检索（Hugging Face `Xenova/bge-m3`，q8 ONNX，约 570 MB，1024 维，CLS 池化），跑在 `@huggingface/transformers` 4.3.1 的工作线程里，纯 CPU。用户问：有没有比 bge-m3 更好的？约束：
>   1. 内容是个人记忆，用户的原话，中文为主、夹英文，大多是短句和短段落；
>   2. 检索是关键词（FTS5）加向量的混合检索，以后可能加重排；
>   3. 要能在 transformers.js 里跑（有 ONNX，最好有量化版），CPU 上一条短句的延迟和内存可接受，体积 2 GB 以内；
>   4. 许可证允许个人使用，商用友好更好。
>
>   §1 是要点。§2 讲二狗现在的接法。§3 讲榜单怎么读。§4 逐个候选。§5 是两项中文检索的代理分数。§6 讲 CPU 速度和内存。§7 讲重排模型。§8 讲换模型的影响。§9 汇总没核实的。§10 列来源。§11 是对比表，§12 是推荐。
> - **标注**：
>   - 不加标的是事实，后面附来源编号（见 §10）。
>   - 【推测】= 作者推断，来源里没有直说。
>   - 【建议】= 作者的建议。
>   - 【未核实】= 没在一手资料里找到定论。
> - **体积**：一律按文件清单里的字节数换算成十进制 MB / GB（1 MB = 10⁶ 字节），和 `bge-m3.ts` 注释里"约 570 MB"的算法一致。ONNX 文件名照 transformers.js 的约定：`model_quantized.onnx` 是 `dtype: "q8"`，`model_q4.onnx` 是 `q4`，`model_fp16.onnx` 是 `fp16`；带 `.onnx_data` 的要把两个文件加起来。
> - **取文方式**：网页经摘要工具取文。表格数字都让工具原样抄出，再和第二个来源对过的地方在正文里注明。拿去做决定之前，关键数字请对照原文再核一遍。

---

## 1. 要点

1. **有更好的，而且能直接替换：Qwen3-Embedding-0.6B**（§4.2）。
   - 同一张 C-MTEB 表（MTEB(cmn, v1)，KaLM-Embedding-V2 论文 v7）里，检索分 71.03，bge-m3 是 65.43，高 5.6 分 [S14]。
   - MMTEB（MTEB(Multilingual, v2)）的检索分 64.64，bge-m3 是 54.60，高 10 分 [S1][S8]。
   - onnx-community 有官方的 transformers.js 版。q8 一个文件 614 MB，和现在的 570 MB 差不多 [S2]。Apache-2.0 [S1]。
2. **代价有三条**（§4.2、§6、§8）：
   - **算得更多**：28 层、非嵌入参数 0.44B [S33]；bge-m3 是 24 层，非嵌入【推测】约 0.30B。【推测】每个 token 的计算量约为 bge-m3 的 1.45 倍。
   - **查询要加指令前缀**：`Instruct: {任务}\nQuery:{查询}`，文档不加 [S1]。二狗的 `Embedder.embed()` 现在不分查询和文档，接口要改。
   - **跨语言对齐比 bge-m3 弱**：MMTEB 的 bitext mining 是 72.22，bge-m3 是 79.11 [S1]。"英文问、中文答"这类查询可能吃亏【推测】。
3. **备选：gte-multilingual-base**（§4.4）。
   - C-MTEB 检索 71.95，和 Qwen3-0.6B 持平 [S14]。
   - 只有 12 层、768 宽，q8 340 MB，查询不用前缀 [S12]。【推测】计算量约为 bge-m3 的 0.28 倍。
   - 短处：多语言和英文检索弱（MMTEB 检索 56.50）[S8]。它的 `model_type` 是 `"new"`，transformers.js 4.3.1 的注册表里没有，要靠 `AutoModel` 的"未知类型退回基类"才能加载 [S27]。这条路没实测。
4. **新出的 harrier-oss-v1-0.6b 值得一起实测，但中文证据不够**（§4.3）。
   - 微软 2026-03-30 发布，MIT [S3][S5]。MMTEB 总分 69.0，比 Qwen3-0.6B 的 64.3 高 [S3]。
   - 没有公开的 C-MTEB 分数，MTEB 结果仓库里也没有它的 T2Retrieval 结果 [S25]。
   - 两项能查到的中文检索代理分数和 Qwen3-0.6B 互有高低（§5）。
   - 它和 Qwen3-Embedding-0.6B 同为 qwen3 架构、同样的查询前缀，onnx-community 有现成的 ONNX（q8 706 MB）[S4]。
5. **EmbeddingGemma（v1 300M、2026-10 新出的 v2）更小更快，但中文检索不占优**（§4.5、§4.6）。
   - v1 的 MMTEB 检索 62.49 [S8]。v2 的 MMTEB 总分 61.36，几乎没涨 [S10]。两者都没有公开的 C-MTEB 分数。
   - v1 是 Gemma 条款 [S7][S11]，v2 改成 Apache-2.0 [S10]。
6. **不推荐的及原因**（§4.7–§4.12）：
   - jina-embeddings-v3 / v5、Conan-embedding-v1：CC BY-NC，不能商用 [S15][S16][S20]。jina-v3 官方 ONNX 也没有 int8 [S16]。
   - multilingual-e5-large：C-MTEB 检索 63.66，不如 bge-m3；最长只有 512 token [S17][S18]。
   - bge-small / large-zh-v1.5：只有中文词表、512 token [S18]。
   - Conan-embedding-v2：1.4B、3584 维，没有 ONNX [S20]。
   - xiaobu-embedding-v2：没写许可证 [S20]。
   - KaLM-Embedding-V2.5：C-MTEB 检索 73.42 是小模型里最高的 [S14]，但只有个人账号转的 ONNX，双向注意力在 transformers.js 里对不对没人验证过 [S21]。
7. **重排**（§7）：
   - 在 Qwen3 自己的测评里，候选是 Qwen3-Embedding-0.6B 召回的前 100 条 [S28]：
     - 中文（CMTEB-R）上最好的小重排是 gte-multilingual-reranker-base：74.08，比只用向量高 3.06；
     - Qwen3-Reranker-0.6B 只高 0.29；
     - bge-reranker-v2-m3 高 1.14。
   - 能不能在 transformers.js 里跑：
     - bge-reranker-v2-m3 能用 `AutoModelForSequenceClassification` 直接跑（q8 571 MB）[S27][S29]；
     - gte 重排和 gte 向量一样卡在 `"new"` 类型上 [S27][S30]；
     - Qwen3-Reranker 要按 CausalLM 读 yes/no 的 logits，q8 1.22 GB [S28]。
   - 注意：transformers.js 的 `text-classification` 管道不收文本对，单 logit 时还会被 softmax 成恒为 1，不能直接当重排用 [S27]。
8. **换模型的影响**（§8）：
   - 二狗的向量表每行记着模型名和维度，换模型就整批重算，表结构不用改；
   - 重算期间语义检索只覆盖已算完的素材；
   - 要改的是推理后端的池化方式和 `Embedder` 接口（分查询和文档）。
9. **CPU 速度没有可用的公开数据**（§6）。唯一的 CPU 数字是 Qwen3-Embedding-0.6B 在 i9-13900HK 上、TEI 的 IPEX 镜像、bf16、12 线程，最小请求约 30 ms，是社区用户报告，不是 transformers.js [S34]。【建议】换之前在本机用二狗自己的记忆样本测延迟、内存和命中率。

---

## 2. 二狗现在怎么接的

- **模型**：`Xenova/bge-m3`，锁定提交 `4de13258`，`dtype: "q8"`，用 `onnx/model_quantized.onnx`（569,694,530 字节）[S35 `bge-m3.ts`]。
- **推理**：工作线程里 `pipeline("feature-extraction", …)`，`pooling: "cls"`、`normalize: true`，CPU 线程数取核数的四分之一、最多 4 个 [S35 `bge-m3-backend.ts`、`bge-m3.ts`]。闲置 10 分钟结束线程，注释说量化版 bge-m3 约占 1 GB 内存 [S35 `worker-host.ts`]。
- **接口**：`Embedder.embed(texts)` 只收一批文字，不区分查询和文档 [S35 `embedder.ts`]。补算向量（`vectors.ts:159`）和检索时算查询向量（`vectors.ts:209`）走同一个函数。
- **向量表**：`material_vectors(material_id, model, dims, vector BLOB)` [S35 `memory-db.ts:43`]。
  - 模型名是"仓库:量化@版本前 8 位"，任何一样变了都整批重算 [S35 `bge-m3.ts`]。
  - 检索只扫当前模型名的向量，暴力点积 [S35 `vectors.ts`]。
- **长度**：每条素材只取前 2000 字算向量（`EMBED_MAX_CHARS = 2000`）。凑批时"条数 × 最长字数"不超过 2000，每批最多 16 条 [S35 `vectors.ts:60-62`]。

---

## 3. 榜单怎么读

- **C-MTEB** 指中文 MTEB。新版 MTEB 叫 **MTEB(cmn, v1)**，KaLM 论文说它"derived from C-MTEB"[S14]。检索是 8 个任务的 nDCG@10 平均。本文用的中文检索分来自三处：
  1. **KaLM-Embedding-V2 论文 Table 3**（arXiv 2506.20923，v7，页眉 2026-09-03）[S14]。同一张表里有 bge-m3、mE5-large、gte-multilingual-base、jina-v3、Qwen3-0.6B、KaLM 三代。**本文的中文主比较都用这张表。**
  2. **Qwen3-Embedding 模型卡**的 C-MTEB 表 [S1]。没写日期，没有 bge-m3。Qwen3-0.6B 的 71.03 和 KaLM 表一致。
  3. **BGE 模型卡**的 C-MTEB 表 [S18]，是 2023 年的老版本，没写日期。Conan-embedding-v1 卡上的表 [S20] 也是这一类。
- **MMTEB** 指 **MTEB(Multilingual, v2)**。三份来源的快照时间不同：
  - Qwen3 模型卡："retrieved from MTEB online leaderboard on May 24th, 2025"[S1]；
  - EmbeddingGemma 论文：快照 2025-09-23 [S8]；
  - jina-v5 论文：2026-02，部分数字是作者自测，标了 † [S15]。
  - 同一个模型在三处的数字基本一致，例如 Qwen3-0.6B 的检索分是 64.64 / 64.65 / 64.7。
- **MTEB(eng, v2)** 的检索分只在 Qwen3 模型卡和 jina-v5 论文里有 [S1][S15]。
- **注意**：
  - 不同来源、不同版本的总分不能直接比，本文只在同一张表里比高低；
  - 榜单测的是"查询 → 段落"，和"短句记忆互相找"不完全一样【推测】；
  - bge-m3 微调时用过 MIRACL 的训练数据，中文还用过 DuReader、mMARCO-ZH、T2-Ranking、CMedQAv2 [S19 论文 §3.1]，所以它在这些数据集上不算零样本。

---

## 4. 逐个候选

每个候选列同样的字段：参数、ONNX 与量化体积、维度（Matryoshka）、最大长度、分数、中英混合、许可、transformers.js、CPU 速度。

### 4.1 bge-m3（基线）

- **参数**：568M [S13 Table 4]。非嵌入部分【推测】约 303M（和 snowflake-arctic-embed-l-v2.0 同为 XLM-R large 结构，后者卡上写 "568M total, 303M non-embedding" [S22]）。
- **ONNX**（`Xenova/bge-m3`）[S19]：
  - q8 569.7 MB；
  - fp16 1.13 GB；
  - q4f16 700 MB；
  - **q4 反而有 1.25 GB**；
  - fp32 2.27 GB。
- **维度**：1024 [S19]。模型卡没提 Matryoshka。
- **最大长度**：8192 [S19]。
- **分数**：
  - C-MTEB 检索 65.43，Mean(Task) 60.34 [S14]；
  - mGTE 论文的中文均分是 60.80 [S13 Table 3]；
  - MMTEB 均分 59.56，检索 54.60 [S1][S8]；
  - MTEB(eng, v2)：【未核实】，几份表里都没有。
- **中英混合**：跨语言对齐强。
  - MMTEB bitext mining 79.11，同表 Qwen3-0.6B 72.22 [S1]；
  - MKQA（跨语言检索）recall@20 67.8，同表 mE5-large 63.5、gte-multilingual-base 65.8 [S13 Table 4]。
- **许可**：MIT [S19]。
- **transformers.js**：`Xenova/bge-m3` 的例子是 `pooling: 'cls', normalize: true`，不用前缀 [S19]。模型卡说 bge-m3 "no longer requires adding instructions to the queries"[S19]。
- **CPU**：二狗代码注释说常驻约 1 GB [S35]，延迟【未核实】。
- 稠密、稀疏、多向量三种检索都支持 [S19]，但二狗只用稠密那一路，关键词交给 FTS5，所以换掉它不损失功能。

### 4.2 Qwen3-Embedding-0.6B（首选）

- **参数**：0.6B，28 层 [S1]。同底座 Qwen3-0.6B 的非嵌入参数 0.44B [S33]。jina-v5 论文写 596M [S15]。
- **ONNX**（`onnx-community/Qwen3-Embedding-0.6B-ONNX`，2025-06-05 建）[S2]：
  - q8（`model_quantized.onnx`）613.5 MB，int8 / uint8 同大；
  - q4f16 567 MB；
  - q4 914 MB；
  - fp16 1.20 GB；
  - fp32 2.40 GB。
  - q4 比 q8 还大，【推测】是 q4 只量化 MatMul，15 万词的嵌入表留着 fp32。
- **维度**：1024，支持 32–1024 任意截断（MRL）[S1]。
- **最大长度**：32K。模型卡的例子用 `max_length = 8192` [S1]。
- **分数**：
  - C-MTEB 检索 71.03，Mean(Task) 66.33 [S1][S14]；
  - MMTEB 均分 64.33，检索 64.64（2025-05-24 榜单）[S1]；
  - MTEB(eng, v2) 均分 70.70，检索 61.83 [S1]；
  - 不加指令（generic）时 MMTEB 均分掉到 61.1，检索 64.2† [S15]。
- **中英混合**：MMTEB bitext mining 72.22，低于 bge-m3 的 79.11 [S1]。模型卡建议多语言场景下"write their instructions in English"[S1]。
- **许可**：Apache-2.0 [S1]。
- **transformers.js**：onnx-community 的例子 [S2]：
  - 写法是 `pipeline("feature-extraction", …)` 加 `pooling: "last_token", normalize: true`；
  - 查询前缀 `Instruct: {任务}\nQuery:`（冒号后没有空格），文档不加；
  - 例子的 dtype 是 `"fp32"`，注释列了 `"fp16"`、`"q8"`；
  - 分词器 `padding_side` 是 `"left"`。
  - transformers.js 4.3.1 的 `last_token` 池化就是取序列最后一个位置（`result.slice(null, -1)`），不看 attention mask [S27]。所以**必须左填充**，否则一批里短的那条会取到填充 token。这个仓库的分词器配置正好是左填充。
  - 指令一般能带来 "1% to 5%" 的提升 [S1]。
- **CPU**：社区用户报告，i9-13900HK、TEI `cpu-ipex` 镜像、bf16、12 线程，"minimal embedding request" 平均约 30 ms [S34]。transformers.js 下【未核实】。

### 4.3 harrier-oss-v1-0.6b / 270m（新增，2026-03）

- **来历**：
  - 微软 Bing 团队发布，HF 仓库 2026-03-30 建 [S5]；
  - Bing 博客 2026-04-07 说 27B 版 "ranking 1st on the multilingual MTEB-v2 benchmark (as of April 6, 2026)"[S6]；
  - 小的两个"additionally trained with knowledge distillation from larger embedding models"[S3]；
  - SkillRet 论文作者说 Harrier 是 Qwen3-Embedding 的微调衍生（二手说法，模型卡没写底座）[S26]。
- **0.6b**：
  - 参数 0.6B，`qwen3` 架构，1024 维，32,768 token，last-token 池化，MIT [S3]。模型卡没提 Matryoshka。
  - ONNX（`onnx-community/harrier-oss-v1-0.6b-ONNX`）：q8 706.5 MB，q4 399 MB，q4f16 353 MB，fp16 1.20 GB，fp32 2.40 GB [S4]。
- **270m**：
  - 参数 270M，标签 `gemma3_text`，640 维，32,768 token，MIT [S3]。
  - ONNX：q8 344 MB，q4 206 MB，q4f16 172 MB，fp16 553 MB，fp32 1.11 GB [S4]。
- **分数**：
  - MTEB v2（多语言）均分：0.6b 69.0，270m 66.5 [S3]；
  - MMTEB 检索分、C-MTEB：【未核实】。模型卡、Bing 博客、Azure Labs 页都没有；MTEB 结果仓库里 0.6b 没有 `T2Retrieval.json`（404）[S25]。
  - 中文代理分数见 §5：0.6b 和 Qwen3-0.6B 一项高一项低。
  - 英文第三方：SkillRet（只留英文技能）nDCG@10 0.6b 66.55、270m 61.17，Qwen3-Embedding-0.6B 58.35，jina-v5-small 59.50 [S26]。
- **中英混合**：【未核实】。
- **许可**：MIT [S3]。270m 带 `gemma3_text` 标签，Gemma 条款要求衍生模型带上使用限制 [S11]；它是不是 Gemma 衍生、条款会不会传下来，【未核实】。
- **transformers.js**：onnx-community 的例子 [S4]：
  - 用 `AutoTokenizer` + `AutoModel`，直接读输出 `sentence_embedding`，池化已经在图里；
  - 例子用 `dtype: "q4"`、`device: "webgpu"`；
  - 查询必须加 `Instruct: {任务}\nQuery: `，FAQ 说不加 "you will see a performance degradation"，文档不加。
  - 0.6b 的分词器配置没写 `padding_side` [S4]。图里的池化怎么处理填充，【未核实】。
- **CPU**：【未核实】。【推测】0.6b 和 Qwen3-0.6B 同结构，速度相同。

### 4.4 gte-multilingual-base（备选）

- **参数**：305M，encoder-only [S12]。配置是 12 层、768 宽、`model_type: "new"` [S12]。
- **ONNX**（`onnx-community/gte-multilingual-base`，2024-08-15 建）[S12]：
  - q8 340.3 MB（int8 / uint8 同大）；
  - fp16 628 MB；
  - q4f16 465 MB；
  - q4 873 MB；
  - fp32 1.26 GB。
- **维度**：768，可取 128–768（模型卡叫"elastic"）[S12]。
- **最大长度**：8192 [S12]。
- **分数**：
  - C-MTEB 检索 71.95，Mean(Task) 62.94 [S14]；
  - mGTE 论文中文均分 62.72，bge-m3 是 60.80 [S13 Table 3]；
  - MMTEB 均分 58.24，检索 56.50 [S8]；
  - 英文：MTEB 英文均分 61.40 [S13 Table 3]，BEIR 51.1（bge-m3 48.7）[S13 Table 4]；MTEB(eng, v2) 检索【未核实】。
- **中英混合**：MKQA recall@20 65.8（bge-m3 67.8），MIRACL 62.1（bge-m3 67.7）[S13 Table 4]。
- **许可**：Apache-2.0 [S12]。
- **transformers.js**：
  - 4.3.1 的 `registry.js` 里没有 `'new'` [S27]。`AutoModel` 遇到未知类型会打警告、退回 `PreTrainedModel` 加载（`BASE_IF_FAIL = true`）；`AutoModelForSequenceClassification` 等别的 Auto 类会直接抛 "Unsupported model type" [S27]。`feature-extraction` 管道走的是哪一条，【推测】是 `AutoModel`，【未核实】。
  - onnx-community 卡片的例子用 `pooling: 'mean'`、查询带检索指令 [S12]。原模型卡的例子取第一个 token（`last_hidden_state[:, 0]`）、不加前缀 [S12]。两者不一致，【未核实】哪个对，【建议】按原卡用 `cls`。
  - 原模型的稀疏向量要靠自带的 Python 代码（`gte_embedding.py`）[S12]。ONNX 里有没有，【推测】没有。
- **CPU**：【未核实】。【推测】Transformer 部分约 85M 参数，是 bge-m3 的 0.28 倍（§6）。

### 4.5 EmbeddingGemma-300m（v1，2025-09）

- **参数**：308M [S9]。嵌入和 Transformer 各占多少，【未核实】。
- **ONNX**（`onnx-community/embeddinggemma-300m-ONNX`）[S7]：
  - q8 309.5 MB；
  - q4 197 MB；
  - q4f16 176 MB；
  - fp32 1.24 GB；
  - fp16 文件有，但模型卡说 "EmbeddingGemma activations do not support fp16 or its derivatives"。
- **维度**：768，Matryoshka 512 / 256 / 128，截断后要重新归一化 [S7]。
- **最大长度**：2048 [S7]。
- **分数**：
  - MMTEB 均分 61.15，检索 62.49 [S7][S8]；
  - MTEB(eng, v2) 均分 69.67 [S7]，检索 55.69 [S15]；
  - C-MTEB：【未核实】，结果仓库里没有 T2Retrieval [S25]。
  - 模型卡还给了 QAT 检查点量化后的分数（Q8_0 的 MMTEB 60.93）[S7]。那是 Google 自己的量化格式，不是 onnx-community 的 q8。
- **中英混合**：【未核实】。
- **许可**：Gemma Terms of Use（2026-04-01 版）[S7][S11]：
  - 可以使用、修改、分发；
  - 受 Prohibited Use Policy 约束；
  - 分发衍生模型要带上使用限制和条款副本；
  - google 原仓库要登录并同意条款才能下载 [S7]。
- **transformers.js**：onnx-community 的例子 [S7]：
  - 用 `AutoModel`，读 `sentence_embedding`，dtype 可选 fp32 / q8 / q4；
  - 查询前缀 `task: search result | query: `，文档前缀 `title: none | text: `。
- **CPU**：Google 只给了 EdgeTPU 上 256 token "<15ms"、量化后 "sub-200MB" 内存 [S9]。CPU 上【未核实】。

### 4.6 EmbeddingGemma 2（新增，2026-10）

- **来历**：HF 上 `google/embeddinggemma-2` 2026-09-14 建、`onnx-community/embeddinggemma-2-ONNX` 2026-10-04 建 [S10]。几篇二手报道说 2026-10-06 正式公布；一手博客没取到，【未核实】。
- **参数**：总 740M，多模态（文字、图、视频、音频）。纯文字部分 270M（130M Transformer + 140M 嵌入）[S10]。模型卡说 "builds upon … Gemma 4" [S10]。
- **ONNX**：文字模型和视觉、音频编码器分文件 [S10]：
  - 文字模型：q8 314 MB，q4 175 MB，q4f16 157 MB，fp16 543 MB，fp32 1.09 GB；
  - 视觉、音频编码器另外几百 MB，纯文字用不到。
- **维度**：768，Matryoshka 512 / 256 / 128 [S10]。
- **最大长度**：8192 [S10]。
- **分数**：
  - MMTEB 均分 61.36（v1 61.15）；
  - MTEB(eng, v2) 68.46（v1 69.67，反而低）；
  - MTEB Code 78.68（v1 68.76）[S10]。
  - 检索分、C-MTEB：【未核实】。中文代理分数见 §5，比 v1 略低。
- **许可**：Apache-2.0 [S10]。
- **transformers.js**：
  - 4.3.1 的注册表里有 `['embedding_gemma2', 'EmbeddingGemma2Model']`，类型是 MultimodalEncoder [S27]；
  - onnx-community 卡说 `feature-extraction` 管道会把所有编码器都加载 [S10]。纯文字要先用 `AutoConfig` 把 `vision_config`、`audio_config` 设成 null，再用 `AutoModel`，输出 `sentence_embedding`；
  - 前缀格式同 v1。
  - 精度说法有冲突：google 模型卡警告 fp16 "can produce NaN or silently degraded embeddings"，onnx-community 卡却列了 fp16 可选 [S10]。
- **CPU**：【未核实】。【推测】Transformer 130M，约为 bge-m3 的 0.43 倍。
- 【推测】刚出两周，社区已经有人传 `embeddinggemma-2-onnx-fix` 这样的仓库 [S10 HF 搜索]，可能还有坑。

### 4.7 jina-embeddings-v3

- **参数**：572M [S15]。
- **ONNX**：官方仓库只有 fp32 2.29 GB 和 fp16 1.15 GB，没有 int8 [S16]。ONNX 要多传一个 `task_id` 输入，选 LoRA 适配器 [S16]。
- **维度**：1024，Matryoshka 32–1024。**最大长度**：8192。均值池化 [S16]。
- **分数**：
  - C-MTEB 检索 68.54 [S14]；
  - MMTEB 均分 58.37，检索 55.76 [S8]；
  - MTEB(eng, v2) 检索 54.3 [S15]。
- **许可**：CC BY-NC 4.0 [S16]。
- **transformers.js**：HF 上按 transformers.js 筛 `jina-embeddings-v3`，结果为空。【推测】`feature-extraction` 管道不会传 `task_id`，要自己调会话。

### 4.8 jina-embeddings-v5-text-small / nano（新增，2026-02）

- **发布**：2026-02-18 [S15]。
- **small**：
  - 677M，底座 Qwen3-0.6B-Base，1024 维（Matryoshka 32–1024），32K，last-token 池化 [S15]；
  - ONNX 在按任务分开的仓库里，retrieval 版只有 fp32 2.39 GB [S15]。
- **nano**：
  - 239M，底座 EuroBERT-210M，768 维（Matryoshka 32–768），8192，last-token 池化，前缀 `Query: ` / `Document: ` [S15]；
  - retrieval 版 ONNX：q8 247 MB，q4 138 MB，q4f16 124 MB，fp16 425 MB，fp32 849 MB [S15]。
- **分数** [S15]：

  | 模型 | MMTEB 均分 | MMTEB 检索 | MTEB(eng, v2) 检索 | RTEB |
  |---|---|---|---|---|
  | small | 67.0 | 64.9 | 60.1 | 66.84 |
  | nano | 65.5 | 63.3 | 58.8 | 64.08 |

  C-MTEB：【未核实】。nano 的中文代理分数见 §5。
- **许可**：CC BY-NC 4.0，商用要联系 Jina [S15]。
- **transformers.js**：
  - 4.3.1 的注册表有 `eurobert` [S27]；
  - 官方卡只有 Optimum / onnxruntime 的例子：输出 `last_hidden_state`，自己取最后一个非填充 token [S15]；
  - 【推测】用 transformers.js 的 `last_token` 池化要左填充或一条一批。

### 4.9 multilingual-e5-large / multilingual-e5-large-instruct

- **multilingual-e5-large**：
  - 560M [S13]，24 层，1024 维，最长 512 token，前缀 `query: ` / `passage: `，均值池化，MIT [S17]；
  - ONNX（`Xenova/multilingual-e5-large`）q8 562 MB [S17]；
  - C-MTEB 检索 63.66（BGE 卡）[S18] / 63.65（KaLM 表）[S14]，比 bge-m3 低。
- **multilingual-e5-large-instruct**：
  - 24 层，1024 维，最长 512 token，查询 `Instruct: {任务}\nQuery: {查询}`、文档不加，均值池化，MIT [S17]；
  - 官方 ONNX 只有 fp32 2.24 GB；社区 `lmo3/multilingual-e5-large-instruct` 有 q8 561 MB [S17]；
  - MMTEB 均分 63.22，检索 57.12；MTEB(eng, v2) 检索 53.47 [S1][S8]。
  - C-MTEB 来源互相矛盾：Qwen3 卡上标 "multilingual-e5-large-instruct" 的那行（58.08 / 58.24 / 检索 63.65）[S1]，和 KaLM 表里 "multilingual-e5-large" 那行一字不差 [S14]，【未核实】哪个标对了。
- **共同短处**：最长 512 token，而二狗每条取前 2000 字（§2），长素材会被截断。

### 4.10 bge-small-zh-v1.5 / bge-large-zh-v1.5

- **small**：
  - 4 层、512 宽、词表 21,128、最长 512 [S18 配置]；
  - q8 24 MB（`Xenova/bge-small-zh-v1.5`）[S18]，【推测】约 24M 参数；
  - 512 维；C-MTEB 检索 61.77，均分 57.82 [S18]。
- **large**：
  - 24 层、1024 宽、词表 21,128、最长 512 [S18 配置]；
  - q8 327 MB [S18]；
  - 1024 维；C-MTEB 检索 70.46，均分 64.53 [S18]。
- **共同**：
  - MIT，可免费商用 [S18]；CLS 池化；
  - 查询指令 `为这个句子生成表示以用于检索相关文章：` 可选，v1.5 不加也行 [S18]。
- **短处**：
  - 21,128 是中文 BERT 词表，【推测】英文能力弱；
  - 最长 512 token；
  - large 的计算量和 bge-m3 一样（同为 24 层 × 1024），检索分只高约 5 分（表不同，不能直接比）。

### 4.11 Conan-embedding-v1 / v2、xiaobu-embedding-v2（C-MTEB 上靠前的中文模型）

- **Conan-embedding-v1**：
  - 0.3B；BERT（24 层、1024 宽、词表 21,128、最长 512），后面接一层 1024→1792 的 Dense [S20]；
  - C-MTEB 均分 72.62，检索 76.67 [S20]；
  - **CC BY-NC 4.0** [S20]；
  - `onnx-community/Conan-embedding-v1` 有 q8 329 MB [S20]，有没有把 Dense 层导进去，【未核实】。原仓库的 Dense 层是 sentence-transformers 的独立模块 [S20]。
- **Conan-embedding-v2**：
  - 1.48B 非稠密层参数，3584 维，32K，Apache-2.0 [S20]；
  - 中文 MTEB 检索 78.31（均分 74.24），英文检索 66.40 [S20]；
  - 没有 ONNX，体积和维度都不合适。
- **xiaobu-embedding-v2**：
  - 0.3B BERT + 1024→1792 Dense [S20]；
  - **模型卡和元数据都没有许可证** [S20]；
  - 仓库里有一个 `onnx/model.onnx` [S20]；
  - Conan 卡上列它的 C-MTEB 均分 72.43，检索 76.5 [S20]。
- **共同**：中文词表、512 token，【推测】英文弱。这些分数来自老版 C-MTEB 表，它们训练时有没有用 C-MTEB 的训练集，【未核实】。

### 4.12 KaLM-Embedding-V2.5（新增）

- **来历**：`KaLM-embedding-multilingual-mini-instruct-v2.5`，HF 仓库 2025-09-29 建 [S21]。
- **规格**：0.5B，底座 Qwen2-0.5B，896 维，Matryoshka 896 / 512 / 256 / 128 / 64，32K，**双向注意力 + 均值池化**，Apache-2.0 [S21]。
- **前缀**：查询默认 `Instruct: Given a query, retrieve documents that answer the query \n Query: `，文档为空 [S21]。
- **分数**：
  - C-MTEB 检索 73.42、Mean(Task) 70.93，是本文小模型里最高的 [S14]；
  - MMTEB 均分 60.1，检索 57.9†；MTEB(eng, v2) 检索 58.5 [S15]。
- **ONNX**：只有个人账号 `thomasht86/…-ONNX`（22 次下载）[S21]。【推测】transformers.js 把 qwen2 这类模型当解码器处理（4.3.1 注册表里 `qwen3` 就在解码器那一组 [S27]），双向注意力有没有正确导出进 ONNX、能不能跑对，【未核实】。

### 4.13 看过、没展开的

- **snowflake-arctic-embed-l-v2.0** [S22]：
  - 568M（303M 非嵌入），1024 维（Matryoshka 到 256），8192，CLS，查询前缀 `query: `，Apache-2.0；
  - 官方 ONNX q8 570 MB，卡上有 transformers.js 例子；
  - MMTEB 检索 58.4 [S15]，C-MTEB【未核实】；
  - 和 bge-m3 同结构同体积，没有明显好处。
- **voyage-4-nano** [S23]：
  - 340M（180M 非嵌入 + 160M 嵌入），默认 2048 维（Matryoshka 2048 / 1024 / 512 / 256），32K，Apache-2.0；
  - onnx-community 有 q8 422 MB；配置是 `qwen3` 加 `use_bidirectional_attention: true`，输出 `pooler_output`；卡上只有 Python 例子；
  - MMTEB 检索 63.6†（自测）[S15]；C-MTEB 和 transformers.js 能不能跑【未核实】。
- **Octen-Embedding-0.6B** [S24]：Qwen3-Embedding-0.6B 的微调，Apache-2.0，RTEB 公开集 0.7241；没提 ONNX。

---

## 5. 两项中文检索的代理分数

harrier、EmbeddingGemma（v1 / v2）、jina-v5-nano 都没有公开的 C-MTEB 检索分。为了有个参照，从 MTEB 官方结果仓库取了两项**已经被评过**的中文检索任务，指标都是 nDCG@10 [S25]：

- **CovidRetrieval**：C-MTEB 里的 8 个检索任务之一，dev，cmn-Hans；
- **MIRACLRetrievalHardNegatives** 的 `zh` 子集。

| 模型 | CovidRetrieval | MIRACL-zh | 结果文件的 mteb 版本 |
|---|---|---|---|
| Qwen3-Embedding-0.6B | **84.76** | 59.22 | 1.38.9 |
| harrier-oss-v1-0.6b | 83.57 | 61.35 | 2.3.0 |
| harrier-oss-v1-270m | 81.60 | 54.59 | 2.3.0 |
| EmbeddingGemma-300m | 78.93 | **64.91** | 1.34.7 |
| jina-embeddings-v5-text-nano | 78.03 | 62.50 | 2.3.11 |
| bge-m3 | 77.51 | 63.64 | 1.12.75 |
| EmbeddingGemma 2 | 76.97 | 61.85 | 2.26.10 |

- **只是两项任务**，结论不能外推。
- bge-m3 用 MIRACL 训练集微调过（§3），它的 MIRACL-zh 不是零样本。
- 各模型是不同 mteb 版本评的。
- MIRACL-zh 那一列，工具抄出的片段没带上 split 名【未核实是不是 dev】。
- 【推测】两项合起来看：Qwen3-0.6B 和 harrier-0.6b 大致同档；EmbeddingGemma 在百科问答类（MIRACL）上不弱，在医疗问答类（Covid）上弱一些。

---

## 6. CPU 速度和内存

**公开数据几乎没有。**

- 唯一的 CPU 数字是 Qwen3-Embedding-0.6B：社区用户在 i9-13900HK（45 W 移动 CPU）上用 TEI 的 `cpu-ipex` 镜像、bf16、12 线程，"minimal embedding request" 平均约 30 ms [S34]。它不是 transformers.js / onnxruntime-node，也不是 q8。
- EmbeddingGemma 只有 EdgeTPU 上 256 token "<15ms" [S9]。
- 网上那张 BGE-M3 和 Qwen3-0.6B 的延迟对比表是在 AMD MI300X 显卡上测的（mmBERT-embed 仓库的提交），不适用。

**【推测】按每个 token 的计算量估。** 短句的计算量基本正比于非嵌入参数，查嵌入表几乎不花时间。每层约 12·h²（注意力 4h² + FFN 8h²）：

| 模型 | 层 × 宽 | 非嵌入参数 | 相对 bge-m3 |
|---|---|---|---|
| bge-m3 / bge-large-zh / Conan-v1 / arctic-l-v2 | 24 × 1024 | 约 303M（arctic 卡上写 303M [S22]） | 1 |
| Qwen3-0.6B / harrier-0.6b / jina-v5-small | 28 × 1024 | 0.44B（Qwen3-0.6B 卡 [S33]；harrier 标 `qwen3`、jina-small 底座是 Qwen3-0.6B-Base，【推测】同结构） | 约 1.45 |
| voyage-4-nano | 12 × 1024 | 180M [S23] | 约 0.6 |
| EmbeddingGemma 2（文字） | — | 130M [S10] | 约 0.43 |
| harrier-270m / EmbeddingGemma v1 | — | 【推测】约 100M（Gemma 3 270M 是 "100 million for our transformer blocks" [S33]；两者是否同底座【未核实】） | 约 0.33 |
| gte-multilingual-base | 12 × 768 | 约 85M | 约 0.28 |
| bge-small-zh-v1.5 | 4 × 512 | 约 13M | 约 0.04 |

- Qwen3 / harrier 的查询还要多带约 20 个 token 的指令前缀，只影响查询，不影响补算【推测】。
- 不同分词器切中文的长短不一样（Qwen 15 万词表、Gemma 25.6 万词表、XLM-R 25 万词表），同一句话的 token 数会差一些，【未核实】差多少。
- **内存**：二狗代码注释说 bge-m3 q8 常驻约 1 GB [S35]。【推测】别的模型大致是"q8 文件大小 + 几百 MB 运行时开销"，没有实测。
- **量化**：q4 版在 CPU 上的速度和精度损失都【未核实】。bge-m3、Qwen3 的 q4 文件比 q8 还大（§4.1、§4.2），在 CPU 上用 q4 没有体积好处。

---

## 7. 重排模型

**分数**：Qwen3-Reranker 模型卡上的表，出版方自测。每个重排模型给 Qwen3-Embedding-0.6B 召回的前 100 条打分 [S28]。

| 模型 | 参数 | CMTEB-R | MMTEB-R | MTEB-R（英） | MLDR |
|---|---|---|---|---|---|
| （只用 Qwen3-Embedding-0.6B，不重排） | 0.6B | 71.02 | 64.64 | 61.82 | 50.26 |
| jina-reranker-v2-base-multilingual | 0.3B | 63.37 | 63.73 | 58.22 | 39.66 |
| gte-multilingual-reranker-base | 0.3B | **74.08** | 59.44 | 59.51 | 66.33 |
| bge-reranker-v2-m3 | 0.6B | 72.16 | 58.36 | 57.03 | 59.51 |
| Qwen3-Reranker-0.6B | 0.6B | 71.31 | **66.36** | **65.80** | **67.28** |

- 中文上 gte 重排提升最多（+3.06），bge 次之（+1.14），Qwen3-Reranker-0.6B 几乎不提升（+0.29），jina 反而拉低。
- 多语言和英文上只有 Qwen3-Reranker-0.6B 是正提升，gte 和 bge 都拉低。
- 【推测】对"中文为主、夹英文"的短句记忆，gte 重排的中文优势最有用，但要在自己的样本上验证。

**能不能在 transformers.js 里跑：**

- **bge-reranker-v2-m3**：
  - Apache-2.0 [S29]；
  - `onnx-community/bge-reranker-v2-m3-ONNX`：q8 570.7 MB，fp16 1.14 GB [S29]；
  - XLM-R 结构，4.3.1 注册表里有 `XLMRobertaForSequenceClassification` [S27]；
  - 做法和 mxbai 卡上的 transformers.js 例子一样 [S32]：用 `AutoTokenizer` 把查询重复 N 份、文档作 `text_pair`，再用 `AutoModelForSequenceClassification` 取 `logits.sigmoid()`；
  - onnx-community 卡上只有 `pipeline('text-classification')` 的单句例子 [S29]，不能照抄（见下）。
- **gte-multilingual-reranker-base**：
  - 306M，8192，Apache-2.0 [S30]；
  - `onnx-community/gte-multilingual-reranker-base`：q8 340.9 MB [S30]；
  - 配置是 `model_type: "new"`、`NewForSequenceClassification` [S30]，`AutoModelForSequenceClassification` 会抛 "Unsupported model type" [S27]；
  - 【推测】可以改用 `AutoModel` 退回基类，直接读会话输出的 `logits`，【未实测】。
- **Qwen3-Reranker-0.6B**：
  - Apache-2.0，32K [S28]；
  - `onnx-community/Qwen3-Reranker-0.6B-ONNX`：q8 1.22 GB，q4 995 MB；卡上说因为外部数据文件的限制，不提供 fp32 和 fp16 [S28]；
  - 用 `AutoModelForCausalLM`：每个候选拼成一段 ChatML 提示（系统说只答 yes/no，用户段放 Instruct、Query、Document，助手段先放空 think 块），读最后位置 "yes"、"no" 两个 token 的 logits，算 yes / (yes + no) [S28]；
  - 【推测】每个候选都要过一遍 0.6B 解码器，又比 bge 多一段提示，CPU 上最慢。
- **jina-reranker-v2-base-multilingual**：
  - 278M，最长 1024 token，**CC BY-NC 4.0** [S31]；
  - q8 279.6 MB [S31]；
  - 官方卡有 transformers.js 例子（`AutoModelForSequenceClassification`，`text_pair`，`sigmoid`）[S31]；
  - 中文分低。
- **`text-classification` 管道不能直接当重排用** [S27]：
  - 4.3.1 的 `TextClassificationPipeline._call` 只收 `texts`，分词时不传第二段文字；
  - 单标签时对 logits 做 softmax。重排模型只有一个 logit，softmax 后恒为 1。

---

## 8. 换模型的影响

- **向量要整批重算**：
  - 模型名是"仓库:量化@版本"，换了就和旧向量对不上 [S35 `bge-m3.ts`]；
  - 检索只扫当前模型名的向量 [S35 `vectors.ts`]，重算完之前，语义检索只覆盖已经算好的素材，关键词检索不受影响；
  - 补算在启动 30 秒后开始，每批最多 16 条 [S35 `vectors.ts`]；
  - 总耗时 = 素材条数 × 每条耗时，【未核实】（取决于 §6 的实测）。
- **表结构不用改**：每行记着 `dims`，从 1024 换到 768（gte、EmbeddingGemma）也能存 [S35 `memory-db.ts:43`]。旧模型的向量会被 `INSERT OR REPLACE` 逐条覆盖。
- **要改的代码**【建议】：
  1. 推理后端：`bge-m3-backend.ts` 写死了 `pooling: "cls"`。
     - Qwen3 要 `last_token`，并确认左填充；
     - harrier / EmbeddingGemma 要用 `AutoModel` 读 `sentence_embedding`；
     - gte 要核对是 `cls` 还是 `mean`（§4.4）。
  2. `Embedder` 接口要分查询和文档，比如加 `embedQuery()`，或给 `embed()` 加一个角色参数。`vectors.ts:209` 的查询走查询前缀，`vectors.ts:159` 的补算走文档（不加或加文档前缀）。
     - 指令文字可以写成二狗自己的任务，例如 "Given a user's question, retrieve the user's own notes that answer it"；
     - Qwen3 模型卡建议指令用英文 [S1]。
  3. 模型文件清单、下载命令、"模型不在"提示文案（`materials.modelMissing.hint` 写死了 "bge-m3 … 约 570 MB"）。
  4. 长度：EmbeddingGemma v1 只有 2048 token，mE5 和 bge-zh 只有 512，二狗每条取前 2000 字（§2）。前两者可能截断，Qwen3 / harrier / gte / EmbeddingGemma 2 不会。

---

## 9. 没核实、没查到的

1. **所有候选在 transformers.js 4.3.1 + CPU 上的延迟、内存**：没有公开数据，本文也没实测（规矩不允许下载）。§6 的倍数是按参数量推的。
2. **harrier-oss-v1 的 MMTEB 检索分和 C-MTEB 分**：模型卡、Bing 博客、Azure Labs 页都没有，MTEB 结果仓库里没有 T2Retrieval。
3. **EmbeddingGemma v1 / v2、jina-v5 的 C-MTEB 分**：没找到。
4. **onnx-community 各 q8 版相对原模型的精度损失**：没有一家给出。
5. **gte-multilingual-base 在 transformers.js 里走 `"new"` 回退能不能正常出向量**，以及池化该用 `cls` 还是 `mean`。
6. **harrier 的 ONNX 图内池化怎么处理填充**（分词器没写 `padding_side`）。
7. **mE5-large-instruct 的 C-MTEB 分数**：Qwen3 卡和 KaLM 表把同一行数字标给了不同模型。
8. **harrier-270m 是否受 Gemma 条款约束**。
9. **EmbeddingGemma 2 的一手发布日期**：只取到 HF 建仓时间和二手报道。
10. **KaLM-V2.5、voyage-4-nano 的双向注意力 ONNX 在 transformers.js 里能不能跑对**。
11. **Conan-embedding-v1 的 onnx-community 版有没有包含 1024→1792 的 Dense 层**；Conan、xiaobu 训练时是否用了 C-MTEB 训练集。
12. **"中英夹杂的同一句话"这种场景的专门评测**：没找到，只能拿 bitext mining、MKQA 这类跨语言指标间接看。

---

## 10. 来源

**模型卡、仓库文件清单**（文件大小来自 `https://huggingface.co/api/models/<仓库>/tree/main/onnx`，2026-10-20 读取）

- [S1] Qwen/Qwen3-Embedding-0.6B 模型卡：https://huggingface.co/Qwen/Qwen3-Embedding-0.6B （MMTEB 表注 "retrieved from MTEB online leaderboard on May 24th, 2025"；论文 arXiv 2506.05176）
- [S2] onnx-community/Qwen3-Embedding-0.6B-ONNX：README、`tokenizer_config.json`、onnx 文件清单、discussions 页；HF API 搜索 `Qwen3-Embedding` + onnx
- [S3] microsoft/harrier-oss-v1-0.6b、microsoft/harrier-oss-v1-270m 模型卡（含 README 原文）
- [S4] onnx-community/harrier-oss-v1-0.6b-ONNX（README、`tokenizer_config.json`、onnx 清单）；onnx-community/harrier-oss-v1-270m-ONNX（onnx 清单）
- [S5] HF API 搜索 `harrier-oss`（各仓库 createdAt）：https://huggingface.co/api/models?search=harrier-oss
- [S6] Bing 博客，2026-04-07：https://blogs.bing.com/search/April-2026/Microsoft-Open-Sources-Industry-Leading-Embedding-Model ；Azure Labs 页 https://labs.ai.azure.com/projects/harrier-oss-v1/
- [S7] google/embeddinggemma-300m 模型卡；onnx-community/embeddinggemma-300m-ONNX（README、onnx 清单）
- [S8] EmbeddingGemma 论文 arXiv 2509.20354，Table 5、Table 6（榜单快照 2025-09-23）：https://arxiv.org/html/2509.20354
- [S9] Google 开发者博客，2025-09-04：https://developers.googleblog.com/en/introducing-embeddinggemma/ ；HF 博客，2025-09-04：https://huggingface.co/blog/embeddinggemma
- [S10] google/embeddinggemma-2 模型卡；onnx-community/embeddinggemma-2-ONNX（README、`config.json`、onnx 清单）；HF API 搜索 `embeddinggemma-2`。二手报道（发布日期）：https://vpsranking.com/news/ai/ai-2026-10-06-google-embeddinggemma-2/ 、https://www.eesel.ai/de/blog/embeddinggemma-2-erklaert
- [S11] Gemma Terms of Use（Last modified 2026-04-01）：https://ai.google.dev/gemma/terms
- [S12] Alibaba-NLP/gte-multilingual-base 模型卡；onnx-community/gte-multilingual-base（README、`config.json`、onnx 清单）
- [S13] mGTE 论文 arXiv 2407.19669，Table 3（MTEB en / zh / fr / pl）、Table 4（MLDR、MIRACL、MKQA、BEIR、LoCo）：https://arxiv.org/html/2407.19669
- [S14] KaLM-Embedding-V2 论文 arXiv 2506.20923v7（页眉 2026-09-03），Table 3 "Detailed model performance on MTEB (cmn, v1) derived from C-MTEB"：https://arxiv.org/html/2506.20923
- [S15] jina-embeddings-v5-text 论文 arXiv 2602.15547，Table 2–4：https://arxiv.org/html/2602.15547 ；Jina 博客 2026-02-19：https://jina.ai/news/jina-embeddings-v5-text-distilling-4b-quality-into-sub-1b-multilingual-embeddings ；jinaai/jina-embeddings-v5-text-small 模型卡；jinaai/jina-embeddings-v5-text-nano-retrieval（README、onnx 清单）；jinaai/jina-embeddings-v5-text-small-retrieval（onnx 清单）；HF API 搜索 `jina-embeddings-v5-text` + onnx
- [S16] jinaai/jina-embeddings-v3：README（正文在约 69 万字符处）、onnx 清单；HF API 按 transformers.js 筛 `jina-embeddings-v3`（空）
- [S17] intfloat/multilingual-e5-large、intfloat/multilingual-e5-large-instruct 模型卡及后者 onnx 清单；Xenova/multilingual-e5-large、lmo3/multilingual-e5-large-instruct onnx 清单
- [S18] BAAI/bge-large-zh-v1.5 模型卡（C-MTEB 表）；BAAI/bge-large-zh-v1.5、BAAI/bge-small-zh-v1.5 的 `config.json`；Xenova/bge-small-zh-v1.5、Xenova/bge-large-zh-v1.5 onnx 清单
- [S19] BAAI/bge-m3 模型卡；Xenova/bge-m3（README、onnx 清单）；BGE-M3 论文 arXiv 2402.03216 §3.1（微调数据含 Mr.TyDi、MIRACL、DuReader、mMARCO-ZH、T2-Ranking、CMedQAv2）
- [S20] TencentBAC/Conan-embedding-v1（模型卡、`config.json`、`2_Dense/config.json`、HF API）；TencentBAC/Conan-embedding-v2 模型卡；onnx-community/Conan-embedding-v1 onnx 清单；lier007/xiaobu-embedding-v2（模型卡、HF API、`2_Dense/config.json`）
- [S21] KaLM-Embedding/KaLM-embedding-multilingual-mini-instruct-v2.5 模型卡；HF API 搜索该名
- [S22] Snowflake/snowflake-arctic-embed-l-v2.0 模型卡（README 正文）、onnx 清单
- [S23] voyageai/voyage-4-nano 模型卡；onnx-community/voyage-4-nano-ONNX（README、`config.json`、onnx 清单）
- [S24] Octen/Octen-Embedding-0.6B 模型卡

**评测数据**

- [S25] MTEB 官方结果仓库 https://github.com/embeddings-benchmark/results ，`results/<模型>/<版本>/CovidRetrieval.json`、`MIRACLRetrievalHardNegatives.json`（2026-10-20 读 main）。版本目录：
  - `Qwen__Qwen3-Embedding-0.6B/b22da495…`
  - `microsoft__harrier-oss-v1-0.6b/f9b9dc8d…`（该目录下 `T2Retrieval.json` 为 404）
  - `microsoft__harrier-oss-v1-270m/31de22b6…`
  - `google__embeddinggemma-300m/64614b0b…`（两个版本目录下 `T2Retrieval.json` 都是 404）
  - `google__embeddinggemma-2/914f7f89…`
  - `jinaai__jina-embeddings-v5-text-nano/4c1f9846…`
  - `BAAI__bge-m3/5617a9f6…`
- [S26] SkillRet 论文 arXiv 2605.05726v1，Table 3：https://arxiv.org/html/2605.05726v1

**transformers.js**

- [S27] `@huggingface/transformers@4.3.1` 发布包源码（https://app.unpkg.com/@huggingface/transformers@4.3.1/files/ ）：
  - `src/pipelines/feature-extraction.js`（`last_token` / `eos` 取 `slice(null, -1)`，`cls` / `first_token` 取 `slice(null, 0)`）；
  - `src/pipelines/text-classification.js`（只收 `texts`，单标签走 softmax）；
  - `src/models/registry.js`（有 `xlm-roberta`、`eurobert`、`qwen3`、`gemma3_text`、`embedding_gemma2`，没有 `new`）；
  - `src/models/auto/modeling_auto.js`（`AutoModel.BASE_IF_FAIL = true`）。
  - 另有 npm registry dist-tags（`latest` = 4.3.1）和官方文档 https://huggingface.co/docs/transformers.js/api/pipelines 、https://huggingface.co/docs/transformers.js/index

**重排**

- [S28] Qwen/Qwen3-Reranker-0.6B 模型卡；onnx-community/Qwen3-Reranker-0.6B-ONNX（README、onnx 清单）
- [S29] BAAI/bge-reranker-v2-m3 模型卡；onnx-community/bge-reranker-v2-m3-ONNX（README、onnx 清单）
- [S30] Alibaba-NLP/gte-multilingual-reranker-base 模型卡；onnx-community/gte-multilingual-reranker-base（`config.json`、onnx 清单、README）
- [S31] jinaai/jina-reranker-v2-base-multilingual 模型卡、onnx 清单
- [S32] mixedbread-ai/mxbai-rerank-large-v1 模型卡（transformers.js `text_pair` + `sigmoid` 例子）

**其他**

- [S33] Qwen/Qwen3-0.6B 模型卡（"Number of Paramaters (Non-Embedding): 0.44B"）；Google 开发者博客 Gemma 3 270M，2025-08-14：https://developers.googleblog.com/en/introducing-gemma-3-270m/
- [S34] Qwen/Qwen3-Embedding-0.6B 讨论 #48（用户 sazlin）：https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/discussions/48
- [S35] 本仓库：
  - `packages/daemon/src/materials/embedding/bge-m3.ts`
  - `packages/daemon/src/materials/embedding/bge-m3-backend.ts`
  - `packages/daemon/src/materials/embedding/embedder.ts`
  - `packages/daemon/src/materials/embedding/worker-host.ts`
  - `packages/daemon/src/materials/memory-db.ts:43`
  - `packages/daemon/src/materials/vectors.ts:60-62、159、209`
  - `packages/protocol/locales/zh-CN/materials.json:11`

---

## 11. 对比表

- "C-MTEB 检索"除注明外都来自 KaLM 论文 Table 3 [S14]。BGE 卡 [S18] 和 Conan 卡 [S20] 的老版 C-MTEB 表另标，不能和前者直接比。
- "MMTEB 检索"来自 [S1][S8][S15]。
- "中文代理"是 §5 的 CovidRetrieval / MIRACL-zh。
- "计算量"是 §6 的【推测】倍数（相对 bge-m3）。
- "—"表示没查到。

| 模型 | 参数 | ONNX q8 体积 | 维度（MRL） | 最大长度 | C-MTEB 检索 | MMTEB 均分 / 检索 | 中文代理 | 许可 | transformers.js 现成仓库 | 查询前缀 | 计算量 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **bge-m3**（现用） | 568M | 570 MB | 1024（无） | 8192 | 65.43 | 59.56 / 54.60 | 77.51 / 63.64 | MIT | Xenova，CLS | 不要 | 1 |
| **Qwen3-Embedding-0.6B** | 0.6B | 614 MB | 1024（32–1024） | 32K | **71.03** | 64.33 / **64.64** | **84.76** / 59.22 | Apache-2.0 | onnx-community，`last_token` | 要 | 约 1.45 |
| harrier-oss-v1-0.6b | 0.6B | 707 MB（q4 399 MB） | 1024（未提） | 32,768 | — | 69.0 / — | 83.57 / 61.35 | MIT | onnx-community，`sentence_embedding` | 要 | 约 1.45 |
| harrier-oss-v1-270m | 270M | 344 MB | 640（未提） | 32,768 | — | 66.5 / — | 81.60 / 54.59 | MIT（Gemma 衍生？） | onnx-community | 要 | 约 0.33【推测】 |
| **gte-multilingual-base** | 305M | 340 MB | 768（128–768） | 8192 | **71.95** | 58.24 / 56.50 | — | Apache-2.0 | onnx-community（`new` 类型靠回退） | 不要 | 约 0.28 |
| EmbeddingGemma-300m | 308M | 310 MB | 768（512 / 256 / 128） | 2048 | — | 61.15 / 62.49 | 78.93 / **64.91** | Gemma 条款 | onnx-community | 要 | 约 0.33【推测】 |
| EmbeddingGemma 2（文字） | 270M（总 740M） | 314 MB | 768（512 / 256 / 128） | 8192 | — | 61.36 / — | 76.97 / 61.85 | Apache-2.0 | onnx-community（要关掉视觉、音频） | 要 | 约 0.43 |
| jina-embeddings-v3 | 572M | 无（fp16 1.15 GB） | 1024（32–1024） | 8192 | 68.54 | 58.37 / 55.76 | — | CC BY-NC | 无（要传 `task_id`） | 选任务 | 约 1（推测） |
| jina-v5-text-nano | 239M | 247 MB | 768（32–768） | 8192 | — | 65.5 / 63.3 | 78.03 / 62.50 | CC BY-NC | 无官方例子 | 要 | — |
| jina-v5-text-small | 677M | 无（fp32 2.39 GB） | 1024（32–1024） | 32K | — | 67.0 / 64.9 | — | CC BY-NC | 无 | 要 | 约 1.45 |
| multilingual-e5-large | 560M | 562 MB | 1024（无） | 512 | 63.65 | — | — | MIT | Xenova | 要 | 1 |
| multilingual-e5-large-instruct | 560M | 561 MB（社区） | 1024（无） | 512 | 63.65？（§4.9） | 63.22 / 57.12 | — | MIT | 社区 lmo3 | 要 | 1 |
| bge-small-zh-v1.5 | 约 24M（推测） | 24 MB | 512（无） | 512 | 61.77（BGE 卡） | — | — | MIT | Xenova | 可选 | 约 0.04 |
| bge-large-zh-v1.5 | 约 326M（推测） | 327 MB | 1024（无） | 512 | 70.46（BGE 卡） | — | — | MIT | Xenova | 可选 | 1 |
| Conan-embedding-v1 | 0.3B | 329 MB（Dense 层？） | 1792（无） | 512 | 76.67（Conan 卡） | — | — | CC BY-NC | onnx-community | — | 1 |
| xiaobu-embedding-v2 | 0.3B | 仓库里只有一个 `model.onnx` | 1792（无） | 512 | 76.5（Conan 卡） | — | — | 没写 | 无 | — | 1 |
| KaLM-Embedding-V2.5 | 0.5B | 个人转换 | 896（896–64） | 32K | **73.42** | 60.1 / 57.9† | — | Apache-2.0 | 个人账号，双向注意力未验证 | 要 | — |

---

## 12. 推荐【建议】

- **首选：Qwen3-Embedding-0.6B（`onnx-community/Qwen3-Embedding-0.6B-ONNX`，q8，614 MB）。** 在同一张 C-MTEB 表上检索分比 bge-m3 高 5.6（71.03 对 65.43），多语言检索高 10 分，体积相当，onnx-community 有现成的 transformers.js 用法，Apache-2.0；代价是每个 token 约 1.45 倍计算、查询要加指令、跨语言对齐比 bge-m3 弱。
- **备选：gte-multilingual-base（`onnx-community/gte-multilingual-base`，q8，340 MB）。** 中文检索和 Qwen3-0.6B 持平（71.95），体积约六成、计算量约 bge-m3 的三成、不用前缀，适合嫌 Qwen3 慢的时候用；代价是英文和多语言检索明显弱，transformers.js 要靠未知类型回退加载，得先实测能不能出对向量。
- **顺手一起测**：harrier-oss-v1-0.6b（MIT）。它和 Qwen3-0.6B 同结构、同前缀格式，后端写一次两个都能跑。多语言总分更高，但中文没有公开的完整分数，要靠自己的样本定。
- **重排先不急着加**：要加的话，中文优先试 gte-multilingual-reranker-base（q8 341 MB，CMTEB-R +3.06，但同样卡在 `"new"` 类型上），能稳跑的是 bge-reranker-v2-m3（q8 571 MB，+1.14）。
- **换之前先实测**：从用户真实记忆里抽 50–100 条"问题 → 应该命中的记忆"，三个模型（bge-m3、Qwen3-0.6B、gte）各跑一遍。比 Recall@10、单条查询延迟、补算一批的耗时、工作线程常驻内存，过了再改默认模型。
