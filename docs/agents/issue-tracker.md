# 任务票：本地 Markdown

这个仓库的票和规格都是 `.scratch/` 下的 markdown 文件。

## 约定

- **一个主题一个目录**：`.scratch/<主题>/`。现有两个主题：`ergou-v2`（主地图）和 `ergou-memory`（记忆子地图）。
- **规格**：`.scratch/<主题>/spec.md`。
- **实现票**：一票一个文件，放在 `.scratch/<主题>/impl/<NN>-<slug>.md`，从 `01` 编号，被依赖的票编号在前。不要把多张票合进一个文件。
  - 不放进 `issues/`：那里是 wayfinder 的决策票。混在一起会编号冲突，地图找前沿时也会把实现票当成待决策的票。
  - 第二阶段新增的实现票，在同一个 `impl/` 里接着往下编号。
  - 票之间的依赖写在顶部一行 `Blocked by: NN, NN`，指同一个 `impl/` 里的票。
- **状态**：写在票文件顶部的 `Status:` 行，取值见 `triage-labels.md`。
- **评论和讨论记录**：追加在文件末尾的 `## Comments` 标题下。

## 当 skill 说"发布到任务票系统"

在 `.scratch/<主题>/` 下新建文件，目录不存在就创建。规格写成 `spec.md`，实现票写进 `impl/`。

## 当 skill 说"取相关的票"

读对应路径的文件。用户通常会直接给路径或票号。

## 地图操作（wayfinder）

`/wayfinder` 用。**地图**是一个文件，每张**子票**各一个文件。

- **地图**：`.scratch/<主题>/map.md`，正文分 Destination / Notes / Decisions so far / Not yet specified / Out of scope 几节。
- **子票**：`.scratch/<主题>/issues/NN-<slug>.md`，从 `01` 编号，正文写问题。票头几行：
  - `Type:` 票型，取 `research` / `prototype` / `grilling` / `task`；
  - `Status:` 状态，取 `claimed` / `resolved`，划出范围的写 `closed (out of scope)`；
  - `Phase:` 属于第一阶段还是第二阶段；
  - `Blocked by: NN, NN` 依赖的票。所列票都 `resolved` 时，这张票才算解除阻塞。
- **前沿**：扫 `.scratch/<主题>/issues/`，找未结、未阻塞、未认领的票，编号小的优先。
- **认领**：先把 `Status:` 改成 `claimed` 并保存，再开始干活。
- **解决**：在 `## Answer` 标题下追加结论，`Status:` 改成 `resolved`，再在 `map.md` 的 Decisions so far 里加一条指针（一句话要点加链接）。
