# ADR-0037 模型服务商可配：默认 DeepSeek，另加一个自定义（OpenAI 兼容）服务商

状态：已定（339 号票）

## 背景

- 73 号票起，模型在服务端（守护进程这台电脑）调用，设置 · 模型里能改默认模型、按 agent 覆盖、选思考档位；但**服务商是一个**：DeepSeek，key 只从 `DEEPSEEK_API_KEY`（服务管家从数据目录密钥区的 `deepseek-api-key.txt` 注入）来。没有 DeepSeek 账号的人拿到二狗就只能看界面、不能说话。
- 二狗自己的代码只认 pi 的模型目录（`@earendil-works/*` 只在 `runtime/agent-child/` 里）。pi 的目录里有没有别家，不由我们决定；目录里没有的服务商，子进程里 `getModel(provider, id)` 是 `undefined`，会话根本起不来。
- 现实里愿意接的人绝大多数手上有的是"某家 OpenAI 兼容的接口"（一家云厂商、一个自建网关、一个个人的代理站），而不是 DeepSeek 账号。OpenAI 兼容这一层的写法（`/chat/completions`、`/models`、`Authorization: Bearer`）已经被大家默认成事实标准。
- 二狗有三处离不开 DeepSeek 自己的东西：记忆的每晚整理用 DeepSeek 的对话接口（`DeepSeekChat`）、联网搜索和读网页用的是 DeepSeek 独有的 Search / Fetch 接口、token 单价表（`token-prices.ts`）里只有 DeepSeek 的价。这三样没法靠"换一个 baseUrl"搬过去。

## 决定

1. **先只做一种：用户自己填的"自定义（OpenAI 兼容）服务商"**（provider id 固定是 `custom`）。不是各家预设，就一个：接口地址、模型 id、接口类型（`openai-completions` / `openai-responses`），key 另外填。
   - 不做各家预设（OpenAI、Anthropic、智谱、月之暗面……)的理由：每加一家都要有人维护它的模型目录、价格、能力（能不能看图、分几档思考）、以及它的接口跟 OpenAI 差在哪；而这些正是 pi 的模型目录在管的东西，我们抄一份进来等于长期跟两家上游赛跑。OpenAI 兼容这一种一次覆盖掉绝大多数"我有某个 key"的情况，剩下的交给"以后按需加预设"（下面第 6 条）。
   - 为什么 `custom` 这个 id 写死不跟着用户改：它是 pi 里的 provider id、`credentials` 的键、`「provider/模型 id」` 的前半，改名会让设置文件、账本、日志里的旧记录对不上。
2. **DeepSeek 仍是默认，位置不动。** `MODEL_PROVIDERS` 的第一项还是 `deepseek`（`deepseek-flash`、思考档位 `high`），`DEFAULT_MODEL_SETTINGS` 就取第一项；没有服务商设置文件时行为和以前一模一样。理由：现在所有使用中的数据和习惯都是 DeepSeek 的（key 文件、账本里的模型名、单价表、搜索和记忆），默认换掉等于把所有人的设置、成本估算、可用功能一起动摇，换来的只是"少填一次设置"。自定义那一行的 `defaultModelId` 是空串：模型 id 是用户填的，谁都不许拿它当默认。
3. **记忆整理、联网搜索/读网页不跟着换，仍然只认 DeepSeek。** 它们走的是 DeepSeek 专有接口，不是"OpenAI 兼容"的对话接口，换个 baseUrl 也调不了；硬做一层"用自定义模型假装搜索"只会把"搜不到"变成"编一个"。所以这几处照旧从 `deepseek` 那一行取 key（`DEEPSEEK_API_KEY` / `secrets/deepseek-api-key.txt`），设置页上明着写一句"换成自定义只换跑对话的模型"。
   - 代价是：只用自定义服务商的人，记忆每晚整理会跳过（没配 DeepSeek key），DeepSeek 的搜索接口也用不了（浏览器搜索、Tavily 那几条路照旧）。这是有意的——宁可少一样功能，也不假装它变了。
4. **自定义模型的元数据按估算填，用户填不了。** pi 的 `ProviderConfig` 要求 `contextWindow`、`maxTokens`、`cost`、`input`、`reasoning` 这些；用户既不知道、也不该被问。取保守值：上下文 128k、一次最多生成 8192 token（够大多数 OpenAI 兼容服务）、`input: ["text"]`（不知道那家收不收图片，图片各家的限制差别最大）、`reasoning: false`（不知道那家认不认 OpenAI 的思考参数，塞过去可能整个请求 400）、单价全 0（不知道价，就按 0 记，消耗页上写明成本是粗估）。
   - 为什么不做成"设置里能填"：多五个要用户查文档才能答上来的字段，答错了报错还更难查；先按保守值跑通，真有人需要再单独开（那时也要先想清楚"填错了谁负责"）。
5. **key 放哪：照服务商登记表，一个服务商一个文件，环境变量注入、网页上能填。** 新增 `CUSTOM_MODEL_API_KEY` 和 `secrets/custom-model-api-key.txt`（服务管家按登记表的 `secretFile` 注入）；网页上填的 key 写进**当前选中服务商**的那个文件、同时换进内存，下一次调用就用新的（319 号票的路子，这次多一个文件而已）。key 不进装配、不进请求体、不回显、日志和报错里去掉。
   - 一个后果要认清：网页上「保存 key」写的是"现在选中的那一个"。想两个服务商都留着 key，就得分别选中各填一次；切到自定义以后填的 key 不会写进 DeepSeek 那份。
6. **以后加别家预设，只改登记表和几处外围。** 加一个服务商 = `MODEL_PROVIDERS` 加一行（id、名字、keyEnv、secretFile、defaultModelId）+ `deploy/lsm/ergo-daemon.example.yaml` 的 `env` 加一条 `from: file` + 两份语言文件加名字；设置页、key 那块、连通测试、列模型都照表来，代码不用动。pi 目录里没有这家的，才需要在 `runtime/agent-child/` 里照 `custom-provider.ts` 登记一份 `ProviderConfig`（还守着 pi 边界）。
   - 这也回答了"以后要不要做 OpenAI / Anthropic 预设"：要做的时候按这条走，不用改模型设置的结构。
7. **设置文件的形状**：`provider`（`deepseek` / `custom`）+ `default` + `agents` + `vision` + 可选的 `custom: { baseUrl, modelId, api? }`。切回 DeepSeek 时**不清空** `custom`（没带就沿用文件里那份），以后再选自定义不用重填；地址末尾的斜杠存的时候去掉，选着 `custom` 却没有这一块按"设置文件读不出来"处理（用默认、设置页上提示）。

## 后果

- 只用 DeepSeek 的人一个字节都不变：设置文件里没有 `custom` 也照样合规，拉起 agent 的装配里没有 `custom` 这一项，模型目录照旧。
- 选自定义以后，秘书、维护者、子 agent、评审、范围审视、换模型时写交接摘要的、斜杠命令说明的翻译——所有跑对话的地方都走同一个服务商。**服务商只有一个模型**，所以设置里那些按 agent 写模型 id 的行在自定义下不起作用（思考档位照旧按每一行；模型 id 换成 `custom.modelId`），页面上不放下拉、直接写出来。
- **代价，明写在用户手册里**：自定义模型的思考档位拨不动（登记成不支持思考）、看图默认按"看不了"（通用开关可以自己打开，但对方收不收图不保证）、单价按 0 记所以消耗页的成本是粗估（别当账单）、上下文和一次最多生成多少 token 是按估算的（那家更大就用不满，更小可能被截断或报错）。
- 记忆整理和联网搜索要 DeepSeek key 这件事没有变，只是现在更容易撞上：换成自定义的人如果从来没配过 DeepSeek key，当晚整理跳过、DeepSeek 的搜索接口用不了。设置页和用户手册都如实写着，不说"换了服务商就都换了"。
- 新加的两个接口（`POST /api/model-settings/custom-models` 列模型、`/api/model-settings/test` 多带一块 `custom` 测连通）让设置页能在存之前先试一下；列模型是守护进程直接 `GET {baseUrl}/models`（带 Bearer key、15 秒超时），列不成只写原因、不算错。
- 测试上不碰真服务：自定义服务商这一侧用本机的假 OpenAI 兼容服务（`packages/daemon/test/helpers/fake-openai.ts`），连通测试和列模型都打到它上面；网页那一侧渲染同一块界面查按钮和提示。以后接别家预设，照这个加假服务。
