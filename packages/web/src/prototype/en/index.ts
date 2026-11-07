// 假数据的英文：按源文件分开放，这里合成一张表
import { EN_DEMO_DEBUG } from "./demo-debug.ts";
import { EN_AGENT_SETTINGS } from "./fake-agent-settings.ts";
import { EN_APP_FILES } from "./fake-app-files.ts";
import { EN_BACKGROUND_AGENTS } from "./fake-background-agents.ts";
import { EN_BRANCHES } from "./fake-branches.ts";
import { EN_CALENDAR } from "./fake-calendar.ts";
import { EN_COMPONENTS } from "./fake-components.ts";
import { EN_CONNECTION } from "./fake-connection.ts";
import { EN_CONVERSATIONS } from "./fake-conversations.ts";
import { EN_DATA_SOURCES } from "./fake-data-sources.ts";
import { EN_DOCTOR } from "./fake-doctor.ts";
import { EN_DATA } from "./fake-data.ts";
import { EN_FOOTPRINTS } from "./fake-footprints.ts";
import { EN_HTTP } from "./fake-http.ts";
import { EN_LONG_TASKS } from "./fake-long-tasks.ts";
import { EN_MANAGED_SERVICES } from "./fake-managed-services.ts";
import { EN_MAP } from "./fake-map.ts";
import { EN_MATERIALS } from "./fake-materials.ts";
import { EN_MEDIA } from "./fake-media.ts";
import { EN_MEMORY_GRAPH } from "./fake-memory-graph.ts";
import { EN_OPERATIONS } from "./fake-operations.ts";
import { EN_PERSONAL_FILES } from "./fake-personal-files.ts";
import { EN_RUNTIMES } from "./fake-runtimes.ts";
import { EN_STANDARD } from "./fake-standard.ts";
import { EN_SYSTEM_PROMPTS } from "./fake-system-prompts.ts";
import { EN_TAKEOVER } from "./fake-takeover.ts";
import { EN_WORKFLOW } from "./fake-workflow.ts";
import { EN_PREVIEW_PAIRING } from "./preview-pairing.ts";
import { EN_PROTO_STORE } from "./proto-store.ts";
import { EN_PROTO_TASK_ACTS } from "./proto-task-acts.ts";
import type { Phrases } from "./phrases.ts";

export const EN_PHRASES: Phrases = {
  ...EN_DEMO_DEBUG,
  ...EN_AGENT_SETTINGS,
  ...EN_APP_FILES,
  ...EN_BACKGROUND_AGENTS,
  ...EN_BRANCHES,
  ...EN_CALENDAR,
  ...EN_COMPONENTS,
  ...EN_CONNECTION,
  ...EN_CONVERSATIONS,
  ...EN_DATA_SOURCES,
  ...EN_DOCTOR,
  ...EN_DATA,
  ...EN_FOOTPRINTS,
  ...EN_HTTP,
  ...EN_LONG_TASKS,
  ...EN_MANAGED_SERVICES,
  ...EN_MAP,
  ...EN_MATERIALS,
  ...EN_MEDIA,
  ...EN_MEMORY_GRAPH,
  ...EN_OPERATIONS,
  ...EN_PERSONAL_FILES,
  ...EN_RUNTIMES,
  ...EN_STANDARD,
  ...EN_SYSTEM_PROMPTS,
  ...EN_TAKEOVER,
  ...EN_WORKFLOW,
  ...EN_PREVIEW_PAIRING,
  ...EN_PROTO_STORE,
  ...EN_PROTO_TASK_ACTS,
};
