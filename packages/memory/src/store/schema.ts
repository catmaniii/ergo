// 记忆 PoC 的表（第 4 节）。所有对象在一个 SQLite 文件里；同一种对象写入的先后看 rowid；数组、对象存 JSON 文本，时间存原样的 ISO 字符串，
// 要按时间查、排序的另存毫秒列（*_ms）。
// - evidence + evidence_fts（关键词，trigram 分词，中文可用）+ evidence_vectors（每条记模型名）；
// - entities + entity_names（名字和别名的小写，按名字找实体）；
// - facts + fact_evidence（按证据反查事实）+ fact_fts / fact_vectors（精炼陈述的索引，和证据的分开，用户 2026-10-20 提）；
// - claims、links、inferences + inference_premises（按前提反查推断，失效传播用）、probes；
// - revisions：修订日志，只追加（触发器挡住改和删）；
// - extraction_log：哪条证据被哪个抽取器处理过（抽取幂等、增量）；counters：各种 id 的计数；
// - rg_*（④ 号票）：推理图谱的账本：竞争假设分组（哪个观察模式、参数、观察到的事实）、组里有哪几条断言、追问是哪个模板出的、
//   明说的事实对应哪条断言、哪条证据被哪个推理实现整理过（reflect 增量、幂等）。它们是从断言、事实推出来的簿记，不进修订日志。
//
// 版本：1 是 188 号票；2 加了 links.weight 和 rg_* 表（MemoryStore.open 给 1 版的库补列）。
// 196 号票加的表都是新表（CREATE IF NOT EXISTS，老库打开时自动建上，不用补列、不升版本）：
// - claim_fts / claim_vectors：断言陈述的关键词、向量索引（照事实精炼陈述那一套）；claim_index：索引了哪句陈述、算出来的适用领域。
//   都是从断言推出来的簿记（rg/claim-index.ts 按需同步），不进修订日志；
// - strategies：交互策略（rg/strategies.ts），每次新建、改动都进修订日志（对象种类 strategy）。
// 198 号票加的表也都是新表（同上，不升版本）：
// - questions：了解你问题（rg/questions.ts）：问什么、为什么问、区分哪几个假设、什么回答支持哪边、领域和场景、优先级、状态、过期时间；
// - question_log：每个问题的经过（生成、问了、跳过、回答、判了、过期、不用问了、别问这个），只追加（触发器挡住改和删）；
// - question_blocks："别问这个"挡住的那一类（topic）；
// - nightly_runs：每日整理（nightly.ts）每一夜推后了几次、什么时候跑的、整理报告。
// 199 号票加的表也都是新表（同上，不升版本）：
// - kg_marks：事实上的标记（说的和做的不一样标 gap、关联到需求断言、写回补的场景），改动经 MemoryStore.recordRevision 记在事实名下；
// - joint_conflicts：推理图谱认过的矛盾（真冲突、说的和做的不一样、观点来回变），记住了下次整理照旧有这组根源假设；
// - joint_writebacks：根源定了以后写回知识图谱的记录（改了哪些事实、改之前是什么），根源变了照它撤回；
// - joint_questions：查不清的矛盾根源、对比模式进"了解你问题"的队列（198 号票的接口还没合，先存在这里）。
// 后三张是推理图谱的簿记，不进修订日志；写回对事实的改动经 updateFact 照常进。
// 226 号票加的表也是新表（同上，不升版本）：predictions：预测账本（结论当时预测了什么、后来应验没有），
// 开着的、判了的都在这里，改动进修订日志（对象种类 prediction）。
// 227 号票加的表也是新表（同上，不升版本）：
// - claim_reviews：对抗复核的结果（结论 id、判断、理由、复核员先写的推断、时间），每条结论一行，不进修订日志。
// 234 号票加的表也是新表（同上，不升版本）：
// - rg_purges：彻底删除的审计（什么时候、为什么、删了哪些证据和事实、哪些结论转待复核、哪些问题标过期）。
//   只记 id 和原因，不记原文；每一行另有一份逐对象的修订日志（删证据、删事实、结论改状态）。
// 267 号票加的表也是新表（同上，不升版本，老库打开时自动建上）：
// - rg_writes：唯一写入口的留痕（rg/write-gate.ts）：每次写碰到的每个对象一行——谁写的（夜班、管理员、用户的表态、用户发起）、
//   经谁转达、做的哪种写操作、推法、依据（只有 id）、原因、这次留下的修订（revisions 的 seq）。只追加（触发器挡住改和删）。
// 272 号票加的表也是新表（同上，不升版本，老库打开时自动建上）：
// - rg_asked：模型版问过、没变化就不再问的账（rg/registry.ts）：哪一步（出假设 propose、往上抽 lift:need / lift:value）、哪个推理实现、
//   问的是哪条（观察的事实 id、下层断言的结论 id）、问的时候它的签名（陈述、状态、证据这些拼起来的散列，不存原文和证据 id）。
//   是簿记，不进修订日志；进了组的不记（以后组撤了还会再问）。
// 329 号票（ADR-0032）：claims 加一列 needs_review（复核标记，"待复核"不再占真值状态）。不升版本：老库打开时
//   MemoryStore.open 补上这一列（默认 0）；老库里状态还是 needs_review 的由 rg/migrate-rules.ts 照新规矩迁移。
// 330 号票（R10，ADR-0032）：predictions 做成预测节点，加四列 premise_ids（从哪几条结论推出来的，JSON 数组）、
//   derivation（deductive 演绎 / defeasible 可废止）、retracted_by（落空时证伪它的观察、作废时被撤的来源）、blame（落空以后往回打来源的结果，JSON）。
//   不升版本：老库打开时 MemoryStore.open 补上这几列（来源 = claim_id，推法按 defeasible，落空的 retracted_by = evidence_id）。
// 283 号票加的表也是新表（同上，不升版本，老库打开时自动建上）：
// - person_info_log：每晚整理认人物信息（kg/person-info.ts，攒成个人档案的候选）看过哪几条证据、用的哪个认法。是簿记，不进修订日志；
//   证据彻底删除时跟着删。

export const SCHEMA_VERSION = 2;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  source_level TEXT NOT NULL,
  mode TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  context TEXT NOT NULL,
  event_time TEXT,
  event_ms INTEGER,
  observed_at TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  source_ref TEXT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_by_time ON evidence (coalesce(event_ms, observed_ms), observed_ms);
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(evidence_id UNINDEXED, body, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS evidence_vectors (
  evidence_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (evidence_id, model)
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_names (
  name_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (name_key, entity_id)
);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_entity TEXT,
  object_value TEXT,
  negated INTEGER NOT NULL,
  statement TEXT NOT NULL,
  assertion TEXT NOT NULL,
  context TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,
  event_time TEXT,
  observed_at TEXT NOT NULL,
  valid_from TEXT,
  valid_from_ms INTEGER,
  valid_to TEXT,
  valid_to_ms INTEGER,
  status TEXT NOT NULL,
  superseded_by TEXT,
  retracted_by TEXT,
  contested_with TEXT NOT NULL,
  extracted_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_by_subject ON facts (subject_id);
CREATE INDEX IF NOT EXISTS facts_by_object ON facts (object_entity);
CREATE TABLE IF NOT EXISTS fact_evidence (
  fact_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (fact_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS fact_evidence_by_evidence ON fact_evidence (evidence_id);
CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(fact_id UNINDEXED, body, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS fact_vectors (
  fact_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (fact_id, model)
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  statement TEXT NOT NULL,
  kind TEXT NOT NULL,
  epistemic TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  context TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  inferred_at TEXT NOT NULL,
  reviewed_at TEXT,
  retracted_by TEXT,
  superseded_by TEXT,
  competes_with TEXT NOT NULL,
  predicts TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS links (
  claim_id TEXT NOT NULL,
  target TEXT NOT NULL,
  polarity TEXT NOT NULL,
  rationale TEXT NOT NULL,
  weight TEXT NOT NULL DEFAULT 'weak',
  PRIMARY KEY (claim_id, target, polarity)
);
CREATE INDEX IF NOT EXISTS links_by_target ON links (target);
CREATE TABLE IF NOT EXISTS inferences (
  id TEXT PRIMARY KEY,
  conclusion_claim_id TEXT NOT NULL,
  premise_ids TEXT NOT NULL,
  method TEXT NOT NULL,
  rationale TEXT NOT NULL,
  by TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inferences_by_conclusion ON inferences (conclusion_claim_id);
CREATE TABLE IF NOT EXISTS inference_premises (
  inference_id TEXT NOT NULL,
  premise_id TEXT NOT NULL,
  PRIMARY KEY (inference_id, premise_id)
);
CREATE INDEX IF NOT EXISTS inference_premises_by_premise ON inference_premises (premise_id);
CREATE TABLE IF NOT EXISTS probes (
  id TEXT PRIMARY KEY,
  discriminates TEXT NOT NULL,
  ask TEXT NOT NULL,
  queries TEXT NOT NULL,
  if_found TEXT,
  outcome TEXT NOT NULL,
  found_evidence_ids TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  op TEXT NOT NULL,
  changes TEXT NOT NULL,
  cause_evidence_id TEXT,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_by_object ON revisions (object_id, seq);
CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON revisions
BEGIN SELECT RAISE(ABORT, '修订日志只追加，不能改'); END;
CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON revisions
BEGIN SELECT RAISE(ABORT, '修订日志只追加，不能删'); END;

CREATE TABLE IF NOT EXISTS extraction_log (
  evidence_id TEXT NOT NULL,
  extractor TEXT NOT NULL,
  fact_ids TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (evidence_id, extractor)
);
CREATE TABLE IF NOT EXISTS person_info_log (
  evidence_id TEXT PRIMARY KEY,
  extractor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rg_groups (
  key TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  params TEXT NOT NULL,
  description TEXT NOT NULL,
  observation_ids TEXT NOT NULL,
  live INTEGER NOT NULL,
  by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rg_members (
  claim_id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  template TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rg_members_by_group ON rg_members (group_key);
CREATE TABLE IF NOT EXISTS rg_probes (
  probe_id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  template TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rg_probes_by_group ON rg_probes (group_key);
CREATE TABLE IF NOT EXISTS rg_explicit (
  fact_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rg_reflected (
  evidence_id TEXT NOT NULL,
  reasoner TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (evidence_id, reasoner)
);
CREATE TABLE IF NOT EXISTS rg_asked (
  step TEXT NOT NULL,
  reasoner TEXT NOT NULL,
  subject TEXT NOT NULL,
  signature TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (step, reasoner, subject)
);

CREATE VIRTUAL TABLE IF NOT EXISTS claim_fts USING fts5(claim_id UNINDEXED, body, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS claim_vectors (
  claim_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (claim_id, model)
);
CREATE TABLE IF NOT EXISTS claim_index (
  claim_id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  domains TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  template TEXT NOT NULL,
  trigger TEXT NOT NULL,
  when_text TEXT NOT NULL,
  actions TEXT NOT NULL,
  basis_claim_ids TEXT NOT NULL,
  status TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS strategies_by_key ON strategies (key);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  topic TEXT NOT NULL,
  kind TEXT NOT NULL,
  sources TEXT NOT NULL,
  text TEXT NOT NULL,
  why TEXT NOT NULL,
  targets TEXT NOT NULL,
  answers TEXT NOT NULL,
  domains TEXT NOT NULL,
  scenes TEXT NOT NULL,
  terms TEXT NOT NULL,
  probe_id TEXT,
  priority REAL NOT NULL,
  priority_detail TEXT NOT NULL,
  status TEXT NOT NULL,
  asked_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  last_asked_at TEXT,
  answer_evidence_id TEXT,
  verdict TEXT,
  clear INTEGER NOT NULL,
  answered_at TEXT,
  applied_at TEXT,
  before_state TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_by_key ON questions (key);
CREATE INDEX IF NOT EXISTS questions_by_status ON questions (status);
CREATE TABLE IF NOT EXISTS question_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS question_log_by_question ON question_log (question_id, seq);
CREATE TRIGGER IF NOT EXISTS question_log_no_update BEFORE UPDATE ON question_log
BEGIN SELECT RAISE(ABORT, '了解你问题的经过只追加，不能改'); END;
CREATE TRIGGER IF NOT EXISTS question_log_no_delete BEFORE DELETE ON question_log
BEGIN SELECT RAISE(ABORT, '了解你问题的经过只追加，不能删'); END;
CREATE TABLE IF NOT EXISTS question_blocks (
  topic TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_id TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nightly_runs (
  night TEXT PRIMARY KEY,
  deferrals INTEGER NOT NULL,
  last_check_at TEXT NOT NULL,
  ran_at TEXT,
  report TEXT
);
CREATE TABLE IF NOT EXISTS kg_marks (
  fact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  detail TEXT NOT NULL,
  active INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (fact_id, kind, ref)
);
CREATE TABLE IF NOT EXISTS joint_conflicts (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sides TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS joint_writebacks (
  group_key TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  root TEXT NOT NULL,
  changes TEXT NOT NULL,
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (group_key, claim_id)
);
CREATE TABLE IF NOT EXISTS joint_questions (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  predicts TEXT NOT NULL,
  made_at TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL,
  evidence_id TEXT,
  judged_at TEXT,
  note TEXT NOT NULL,
  premise_ids TEXT NOT NULL DEFAULT '[]',
  derivation TEXT NOT NULL DEFAULT 'defeasible',
  retracted_by TEXT,
  blame TEXT
);
CREATE INDEX IF NOT EXISTS predictions_by_claim ON predictions (claim_id);
CREATE INDEX IF NOT EXISTS predictions_by_status ON predictions (status, due_at);
CREATE TABLE IF NOT EXISTS claim_reviews (
  claim_id TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  why TEXT NOT NULL,
  inference TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rg_writes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  via TEXT,
  op TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  method TEXT,
  basis TEXT NOT NULL,
  reason TEXT NOT NULL,
  revision_seqs TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rg_writes_by_object ON rg_writes (object_id, seq);
CREATE TRIGGER IF NOT EXISTS rg_writes_no_update BEFORE UPDATE ON rg_writes
BEGIN SELECT RAISE(ABORT, '写入口的留痕只追加，不能改'); END;
CREATE TRIGGER IF NOT EXISTS rg_writes_no_delete BEFORE DELETE ON rg_writes
BEGIN SELECT RAISE(ABORT, '写入口的留痕只追加，不能删'); END;

CREATE TABLE IF NOT EXISTS rg_purges (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  reason TEXT NOT NULL,
  material_ids TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,
  fact_ids TEXT NOT NULL,
  claim_ids TEXT NOT NULL,
  question_ids TEXT NOT NULL
);
`;
