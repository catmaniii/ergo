// 数据源（295 号票，ADR-0027 的"数据源"贡献点）：插件写数据源用 api.ts 的类型；组合根建登记表、密钥区、用法开关、服务，
// 删除参与方登记数据源那一份。303 号票：插件把记录写成素材用 material.ts 的 dataSourceMaterial。
export type { DataSource, DataSourceContext, DataSourceFileType, DataSourceImportContext, DataSourceItem, DataSourceRecheckContext, DataSourceRecords, DataSourceSchedule, DataSourceSecrets, DataSourceStatus, DataSourceSyncContext, DataSourceSyncResult, ImportFile } from "./api.ts";
export { recordDisconnect, registerDataSourceDeletion } from "./deletion.ts";
export { DATA_SOURCE_DISCONNECTED, DATA_SOURCE_SYNCED, DATA_SOURCES_CHANNEL } from "./events.ts";
export { openFolderOnDesktop } from "./import-folder.ts";
export { dataSourceMaterial, type DataSourceRecordMaterial } from "./material.ts";
export { createDataSourceRegistry, type DataSourceEntry, type DataSourceOwner, type DataSourceRegistry } from "./registry.ts";
export { createDataSourceSecrets, type DataSourceSecretStore, redactSecrets } from "./secrets.ts";
export { createDataSources, type DataSources, type DataSourcesOptions } from "./service.ts";
export { createDataSourceSettings, type DataSourceSettings } from "./settings.ts";
