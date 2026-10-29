# ADR-0035 素材库的文件改名 materials.db，老库启动时搬一次

状态：已定（用户 2026-10-29）

## 背景

- 用户 2026-10-29 说："`db\memory.db` 这个名称和 memory 插件的目录冲突了容易产生误解，这个 db 能不能换个名字。"
- 记忆插件的数据在 `<数据目录>/memory/<插件 id>/`（ADR-0034），而素材库其实是**内核**的（ADR-0006）：它保管本人的话的原文副本、照做记忆命令的删除和标记，记忆插件只是往里采（129 号票）。两个都叫 memory，看数据目录的人容易当成一个东西。
- 这个文件名从 08 号票起一直叫 `memory.db`，用户的机器上已经有这个库，改名不能丢数据。

## 决定

1. **素材库的文件改叫 `db/materials.db`**（`config/data-dir.ts` 的 `materialsDb`）；老位置 `db/memory.db` 另叫 `legacyMemoryDb`，**只给启动时的迁移读一次**，别处不用。库里的表、字段、`PRAGMA user_version` 一个都不动——改的只是文件名。
2. **启动时搬一次**：组合根在**打开素材库之前**（`openMaterials` 之前）调 `materials/migrate-materials.ts` 的 `migrateMaterialsDb`，照 338 号票推理库那一套，并把文件操作抽成共用的 `migrate/legacy-db.ts`：
   - 先把老库连同 `-wal` / `-shm` 复制一份到 `<数据目录>/backup/pre-migration-<时间>/`；
   - 再把它搬到新名字（同盘改名，跨盘或被占着退回复制 + 删），`-wal` / `-shm` 跟着落到新名字旁边；
   - 写记号 `db/materials-migrated.json`（`{ format, at, from, backup }`）；
   - 新位置已经有了就不动（幂等），两边都没有就是新装、什么都不做；
   - **搬不成（被占用、权限、磁盘满）不拦启动**：记一条写明"会用新的空库、以前的素材要从事件日志重建、原文副本一条不动"的日志，素材库打开新的空库、从事件日志补采；
   - 回滚 `rollbackMaterialsDb` 把 `materials.db` 搬回 `memory.db`、删掉记号，老位置已经有了就拒绝。
3. **ADR-0006、0008 里写 `memory.db` 的地方不改**：它们记的是当时的决定，改了就是篡改历史。文件名的新约定记在这里。

## 后果

- 数据目录里不再有和记忆插件目录重名的库；用户手册的数据目录表、开发者指南、`docs/memory-system.md`、`docs/memory-architecture.md` 都改成 `materials.db`。
- 升级的人第一次启动会多一步备份和改名（老库一个字节不动地备份在 `backup/pre-migration-<时间>/` 里）；改名失败的人照常启动，素材由事件日志重建，原文副本不受影响，处理完之后重启会再试一次。
- `db/` 里多一个小记号文件 `materials-migrated.json`，随快照走，无害。
