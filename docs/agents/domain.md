# 领域文档

各个 engineering skill 在探索代码时，怎样使用这个仓库的领域文档。

## 动手前先读

- 根目录的 **`CONTEXT.md`**；或者根目录有 **`CONTEXT-MAP.md`** 时读它，它指向每个上下文各自的 `CONTEXT.md`，读和当前话题相关的那几个。
- **`docs/adr/`**：读和你要动的部分相关的 ADR。多上下文的仓库，还要看 `src/<上下文>/docs/adr/` 里只属于那个上下文的决定。

这些文件哪个不存在，就**直接跳过**：不提它缺了，也不建议先建好。`/domain-modeling` skill（经由 `/grill-with-docs` 和 `/improve-codebase-architecture` 调用）会在术语或决定真正定下来时再创建它们。

## 文件结构

单一上下文的仓库（大多数仓库，包括本仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文的仓库（根目录有 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 全系统的决定
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 只属于这个上下文的决定
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 用术语表里的词

你的产出里提到某个领域概念时（票的标题、重构提案、假设、测试名），用 `CONTEXT.md` 里定义的那个词。术语表明确说了要避免的同义词，就别用。

需要的概念术语表里还没有，这本身是个信号：要么你在发明项目里不用的说法（重新考虑），要么术语表真有缺口（记下来交给 `/domain-modeling`）。

## 和 ADR 冲突要明说

你的产出和某条 ADR 相矛盾时，要明确指出来，不要悄悄推翻：

> _和 ADR-0007（订单用事件溯源）相矛盾，但值得重新讨论，因为……_
