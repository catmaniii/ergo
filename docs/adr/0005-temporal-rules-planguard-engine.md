# 时序规则照搬 planguard 的引擎，二狗只扩展规则能看到的东西

规格第 9 节要求时序规则"照搬 AgentSense planguard 的引擎核心（expr + spec + checker），规则格式与它兼容"。05 号票照这样做了：`packages/daemon/src/guard/planguard/` 是从 AgentSense 搬来的引擎，语义不改，来源提交和文件哈希记在同目录的 `VERSION` 里。二狗的规则（v1 模板、计划里阶段和阶段组的规则、以后从对话编译出来的规则）都用 planguard 的格式写，交给这个引擎判。

但 planguard 是为 AgentSense 的模拟场景写的：参数是手机路径这类普通字符串，事实由场景自己给，执行时还有一层"和已授权计划对不对得上"的检查。二狗要判的是真实工具：Windows 路径（不分大小写）、通用 bash 拆出来的伪工具、git 状态这类调用方现取的环境事实。所以二狗在引擎外面加了一层，决定**规则能看到什么**，引擎本身不动。

## 决定

- **引擎不改语义**：`expr.ts`、`checker.ts` 原样搬，`spec.ts` 只搬规则的键和参数规范化。只为本仓库的 TypeScript 和 oxlint 设置改写法，另外从 `expr.ts` 导出了 `Op` 类型和占位符正则 `PLACEHOLDER`（给扩展运算和规则校验用）。`planguard/` 里的文件不引用二狗的任何模块。以后同步上游：比对 `VERSION` 里的哈希，重新搬，再把这两处导出补上。
- **二狗的扩展运算从外面注入**：`path_within`（按 Windows 语义判断路径在不在某个目录里）写在 `guard/rule-ops.ts`，时序规则的检查（`temporal-rules.ts`）加载时调 `installErgouOps()` 把它注册进引擎的运算表 `OPS`。planguard 自带的 `startswith` 分大小写，还会把 `E:\work\notes2` 当成在 `E:\work\notes` 里面。
- **操作数个数表归规则校验**：引擎本身不查操作数个数，planguard 的 `policies-check` 才查。二狗的这张表（`OP_ARITY`）放在 `rule-validation.ts`，扩展运算的个数从 `rule-ops.ts` 的 `ERGOU_OPS` 取。
- **规则环境由二狗搭**（`rule-steps.ts`、`rule-env.ts`）：
  - `$current`、`$prior` 是规范化之后的调用。参数名照工具注册表，路径解析成绝对路径，取不到的值是"未知"。另外推出几项字段：`paths`（每个路径参数的区域、是否被删除或覆盖、是否已提交、是不是密钥文件）、`recipients`（没有收件人参数的发送用目标对象）、`content`、`secrets`、`sends`。这样一条规则可以同时管几种工具，不用逐个工具去写各自的参数名；
  - `$facts` 由调用方传入的环境事实组成：`files`、`git`、`scripts` 三个列表，加上调用方声明的其他事实（`extra`）。此外还有 `$agent`、`$task`、`$now`。
- **只在执行时检查**：没有搬规划时的审查和修补，也没有计划一致性检查。授权项、阶段这些归守卫和 13 号票的控制器管。`modes` 里没有 `runtime` 的规则校验不过。`$step` 永远不存在，只是为了兼容才允许写。
- **和 planguard 不同的地方**（都在引擎外面做）：
  - `on_violation` 多一个值 `pull_back`（按规则退回：不执行、不问用户，说明怎么补救，不是处置的一档）。`block` 为"永不"，`confirm` 和不写为"先问我"，和 planguard 一致；
  - 判断不了一律"先问我"。`trigger.where` 判断不了时也算判断不了（planguard 当成不触发），二狗先自己算一遍 `trigger.where` 再交给引擎；
  - "之前"按范围取：效果日志任务内只看同一任务，任务外只看同一会话段；一条 bash 拆出的几条调用，对"之前不能做过"只算真正可能先执行的（`&&`、`;` 的前一段，管道各段互相算）。
- **v1 模板也是 planguard 规则**，按工具注册表生成（`rule-templates.ts`）。它和计划里的规则走同一个引擎、同一套校验，在计划卡上也能用同样的方式显示。

## Considered Options

- **v1 模板直接写成 TypeScript 检查**：写起来最省事。但这样模板和计划里的规则就是两套东西：校验、显示、"判断不了"的处理都要各做一遍；而且规格要求模板是时序规则。
- **全部用 planguard 原有的运算来写，不扩展**：路径比较只能拿 `startswith` 凑。它分大小写，还会把同名前缀的目录误判成父子；要补救，就得在环境里预先算好带分隔符的前缀，规则也会写得很绕。
- **把 `path_within` 直接写进 `expr.ts`**：第一版是这样做的，`expr.ts` 因此要引用二狗的路径模块，同步上游时还得手工合并。改成从外面注册以后，`planguard/` 可以整目录替换。
- **把推出来的字段做成运算**（比如 `committed(path)`、`secret_file(path)`）：运算就得偷偷去读环境里的事实，而 planguard 的运算本来只看操作数。推出来的字段放在"一步"上，规则写起来也更直观。
- **改 planguard 上游，再同步过来**：planguard 是另一个仓库的东西，二狗的需求（Windows 路径、伪工具）不该推给它。

## Consequences

- planguard 的规则文件在二狗里原样能跑：AgentSense 的 storage、office 用例已经搬进守卫的场景文件。结果和 AgentSense 的差别有两处：`$step` 不存在；没有计划一致性检查。
- 写规则的人（26 号票编译对话里的限制、维护者写计划）要用二狗的规则环境，见 `rule-validation.ts` 开头的说明和 `docs/dev.md` 的"时序规则"一节。规则写错了，存计划时就会被 `validateTemporalRules` 拦下。
- 同步上游时，`expr.ts` 导出的 `Op` 和 `PLACEHOLDER` 要补回去；扩展运算在 `rule-ops.ts` 里，不受影响。
