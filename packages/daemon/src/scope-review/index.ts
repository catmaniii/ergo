// 范围审视（规格第 10 节，18 号票）在守护进程这一侧的入口：别处只从这里取东西。
export { createScopeReview, ownershipOf, RECENT_SCOPE_RECORDS, type ScopeOwner, type ScopeReview, type ScopeReviewOptions, TASK_RECORDS_FILE } from "./scope-review.ts";
export { type MaintainerScopeReview, sessionScopeReview } from "./session.ts";
export { RECENT_SCOPE_RECORDS_TITLE, scopeReviewInstructions } from "./texts.ts";
export { scopeRecordsView } from "./views.ts";
export { registerScopeRecordDeletion, scopeRecordPurge, scopeRecordQuotes } from "./purge.ts";
