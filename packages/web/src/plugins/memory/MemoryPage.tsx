// "记忆"（167 号票，导航栏的"记忆"，#/more/memory）。285 号票重排（用户 2026-10-26 看过对照图定的）：
// - 最上面一张卡"和记忆管理员聊"：写每晚 03:00 整理、最近一次的结果，和了解你访谈聊到哪了；点了是和记忆管理员的整页对话
//   （#/more/memory/curator，CuratorPage.tsx：宽屏也不留左边的栏目，‹ 回记忆页；输入框上面一行访谈的进度和"开始访谈"）。
//   记忆管理员不再是栏目里的一层，284 号票的"找管理员聊聊"那一行去掉（开访谈在对话里，/interview 照旧）；
// - 下面四栏，从你确认过的、到推断的、到还拿不准的、到原始记录（route.ts 的 MEMORY_LAYERS）：
//   - 档案（#/more/memory/files[/<编号>]）：281 号票的个人档案，按"我 / 家人 / 重要的人 / 其他人"分组（内核的页面 PersonalFilesColumn）；
//   - 结论（#/more/memory/claims[/<编号>]，ClaimsBrowse.tsx）：按层分组、按状态筛；点一条是它的证据链和竞争解释（EvidenceBrowse.tsx——
//     233 号票的"证据与推理"那一栏没点开时就是结论列表少了筛选，285 号票并进来；旧地址 #/more/memory/evidence[/<编号>] 换过来）；
//   - 问题箱（#/more/memory/questions，QuestionsBrowse.tsx）：整理时还拿不准的地方变成的问题；
//   - 素材（#/more/memory/materials，MaterialsBrowse.tsx）：原始记录，列表上写现在一共几条；顶栏"成批删除"进 #/more/memory/materials-delete
//     （MaterialsBulkDelete.tsx，原来设置里"删除素材"那一整套）；点开一条是再下一级，标题写"素材详情"；
// - 最下面隔一道线一行"数据源"（295 号票，设置下面的内核页面：外面接进来的数据是素材的又一个来处）；
// - 再下面一个默认收起的"会意 · 设置"块（336 号票）：记忆的三个开关（简报、顺口问、每周约访谈）从设置列表搬到了这里
//   （MemorySettingsSection.tsx），记忆页里就能找到；页头那行写这套记忆系统的名字（「会意」/ Subtext，plugins/memory/system.ts）。
// 排法照设置（MorePage 的 SettingsSection）：记忆直接显示在导航里时，宽屏左边是首页、右边是选中的那栏（没选时是档案）；竖屏先列首页，
// 点进去的栏返回到首页。记忆管理员的对话两种都是整页。
// 收进"更多"时（MemoryColumn）：那一栏里先列首页，点进去的栏返回到首页。标题栏的 ‹ 回上一级不压新记录（goBackTo）。
// 193 号票：挪进记忆插件（plugins/memory/plugin.tsx 登记成网页插件的页面），记忆插件停用时整页不出现（导航里没有"记忆"，
// 设置里列出内核的"删除素材"、"更多"里列出个人档案，删除和档案照常）。成批删除、素材详情、档案是内核的，从这里引。
import { useEffect, useState } from "react";
import { goBackTo, type Navigate, toHash } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { retryLoad } from "../../app/retry-load.ts";
import { ASSISTANT_NAME_MARK, type InterviewStatusView, memoryKeeperInterviewLine, memoryKeeperNightLine, type MemorySummaryView, t, tTable } from "../../state/index.ts";
import { NamedText } from "../../ui/assistant-name.tsx";
import { ListDetail, TopBar } from "../../ui/common.tsx";
import { Icon } from "../../ui/icons.tsx";
import { MaterialsBrowse } from "./MaterialsBrowse.tsx";
import { MaterialsBulkDelete } from "../../pages/more/MaterialsBulkDelete.tsx";
import { PersonalFilesColumn } from "../../pages/more/PersonalFilesPage.tsx";
import { ClaimsBrowse } from "./ClaimsBrowse.tsx";
import { EvidenceBrowse } from "./EvidenceBrowse.tsx";
import { QuestionsBrowse } from "./QuestionsBrowse.tsx";
import { MemoryCuratorPage } from "./CuratorPage.tsx";
import { MemorySettingsSection } from "./MemorySettingsSection.tsx";
import { isMemoryItem, MEMORY_ITEMS_WITH_SUB, MEMORY_LAYERS, type MemoryItem, type MemoryLayer, memoryRedirect, memoryRoute } from "./route.ts";
import { memorySystemTagline } from "./system.ts";

/** 几栏的名字（171 号票起按当前语言现取） */
const LAYER_TITLE: Readonly<Record<MemoryLayer, string>> = tTable({
  files: "pages.memory.files",
  claims: "pages.memory.claims",
  questions: "pages.memory.questions",
  materials: "pages.memory.materials",
});

/** 首页上每栏的一句说明（句子里的名字占位由 NamedText 换成名字标签） */
const LAYER_SUB_KEY: Readonly<Record<MemoryLayer, string>> = {
  files: "pages.memory.filesSub",
  claims: "pages.memory.claimsSub",
  questions: "pages.memory.questionsSub",
  materials: "pages.memory.materialsSub",
};

/** 一栏的标题栏写什么：结论里点开的一条写"证据与推理"，素材里点开的一条写"素材详情" */
function layerTitle(item: Exclude<MemoryItem, "curator" | "files">, sub: string | undefined): string {
  if (item === "materials-delete") return t("pages.memory.bulkDeleteTitle");
  if (sub !== undefined) return item === "claims" ? t("pages.memory.evidence") : t("pages.memory.materialDetail");
  return LAYER_TITLE[item];
}

/** 一栏的上一级：点开的一条回到它的列表，成批删除回到素材，别的回到首页 */
function parentOf(item: MemoryItem, sub: string | undefined) {
  if (sub !== undefined) return memoryRoute(item);
  if (item === "materials-delete") return memoryRoute("materials");
  return memoryRoute();
}

/** 地址里的再下一级（点开的一个人、一条结论、一条素材）只在有下一级的栏里算数（193 号票起核心的路由原样交过来，由这里认） */
const subOf = (item: MemoryItem, sub: string | undefined) => (MEMORY_ITEMS_WITH_SUB.includes(item) ? sub : undefined);

/** 旧地址（证据与推理）在地址栏里换成新地址，不压新记录；换之前照新地址画 */
function useLegacyRedirect(item: string | undefined, sub: string | undefined): { item: string | undefined; sub: string | undefined } {
  const moved = memoryRedirect(item, sub);
  const movedHash = moved === undefined ? undefined : toHash(moved);
  useEffect(() => {
    if (movedHash !== undefined) window.location.replace(movedHash);
  }, [movedHash]);
  return moved?.tab === "more" ? { item: moved.item, sub: moved.sub } : { item, sub };
}

/** 记忆直接显示在导航里时：宽屏左边首页、右边选中的那栏；竖屏先列首页，点进去的栏返回到首页。记忆管理员的对话都是整页 */
export function MemorySection({ wide, item: rawItem, sub: rawSub, navigate }: { wide: boolean; item?: string | undefined; sub?: string | undefined; navigate: Navigate }) {
  const legacy = useLegacyRedirect(rawItem, rawSub);
  const layer = isMemoryItem(legacy.item) ? legacy.item : undefined;
  const sub = layer ? subOf(layer, legacy.sub) : undefined;
  // 285：记忆管理员是整页对话（宽屏也不留左边的栏目），‹ 回记忆页
  if (layer === "curator") return <MemoryCuratorPage wide={wide} onBack={() => goBackTo(memoryRoute())} />;
  if (!wide) return layer ? <MemoryLayerCol item={layer} sub={sub} navigate={navigate} onBack={() => goBackTo(parentOf(layer, sub))} /> : <MemoryHome navigate={navigate} />;
  // 宽屏左边一直是首页，右边没选栏时就是档案（不留一块空白）；点开的一条、成批删除才有返回
  const shown = layer ?? "files";
  const home = <MemoryHome current={shown} navigate={navigate} />;
  const detail = <MemoryLayerCol item={shown} sub={sub} navigate={navigate} onBack={sub !== undefined || shown === "materials-delete" ? () => goBackTo(parentOf(shown, sub)) : undefined} />;
  return <ListDetail wide={wide} list={home} detail={detail} listWidth={280} />;
}

/** 记忆收进"更多"时右边（竖屏是整页）那一栏：先列首页（onBack 回"更多"，宽屏没有），点进去的栏返回到首页 */
export function MemoryColumn({ item: rawItem, sub: rawSub, navigate, onBack }: { item?: string | undefined; sub?: string | undefined; navigate: Navigate; onBack: (() => void) | undefined }) {
  const legacy = useLegacyRedirect(rawItem, rawSub);
  const layer = isMemoryItem(legacy.item) ? legacy.item : undefined;
  if (!layer) return <MemoryHome navigate={navigate} onBack={onBack} />;
  const sub = subOf(layer, legacy.sub);
  if (layer === "curator") return <MemoryCuratorPage wide={false} onBack={() => goBackTo(memoryRoute())} />;
  return <MemoryLayerCol item={layer} sub={sub} navigate={navigate} onBack={() => goBackTo(parentOf(layer, sub))} />;
}

/** 首页每栏后面的数：档案几份、素材和结论的条数、问题箱开着的几个；各取各的，取不到就不写 */
interface Counts {
  files?: number;
  materials?: number;
  claims?: number;
  openQuestions?: number;
}

/** 首页：顶上"和记忆管理员聊"那张卡，四栏，最下面数据源 */
function MemoryHome({ current, navigate, onBack }: { current?: MemoryItem | undefined; navigate: Navigate; onBack?: (() => void) | undefined }) {
  const { http } = useStore();
  const [counts, setCounts] = useState<Counts>({});
  const [summary, setSummary] = useState<MemorySummaryView>();
  // 284 号票：了解你访谈的样子（聊过几个、下次聊什么、是不是正在聊）；取不到就只写一句说明
  const [interview, setInterview] = useState<InterviewStatusView>();
  useEffect(() => {
    let live = true;
    http
      .memoryInterview()
      .then((view) => live && setInterview(view))
      .catch(() => {});
    http
      .personalFiles()
      .then((view) => live && setCounts((cur) => ({ ...cur, files: view.files.length })))
      .catch(() => {});
    http
      .materialScope()
      .then((s) => live && setCounts((cur) => ({ ...cur, materials: s.count })))
      .catch(() => {});
    retryLoad(() => http.memorySummary())
      .then((s) => {
        if (!live) return;
        setSummary(s);
        setCounts((cur) => ({ ...cur, claims: s.ready ? s.total : undefined, openQuestions: s.ready ? s.openQuestions : undefined }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [http]);
  // 成批删除是素材的下一级：亮着素材
  const on = current === "materials-delete" ? "materials" : current;
  const countText = (l: MemoryLayer): string => {
    if (l === "files") return counts.files === undefined ? "" : t("pages.memory.filesCount", { count: counts.files });
    if (l === "materials") return counts.materials === undefined ? "" : t("pages.memory.materialsCount", { count: counts.materials });
    if (l === "claims") return counts.claims === undefined ? "" : t("pages.memory.claimsCount", { count: counts.claims });
    return counts.openQuestions === undefined ? "" : t("pages.memory.questionsCount", { count: counts.openQuestions });
  };
  return (
    <div className="chat-col">
      <TopBar title={t("shell.pages.memory.title")} onBack={onBack} />
      <div className="scroll">
        {/* 336 号票：标题下面一行写清这是哪一套记忆系统（「会意」/ Subtext），导航那一项还是"记忆" */}
        <div className="menu memory-system" data-system="memory">
          {memorySystemTagline()}
        </div>
        {/* 285：记忆管理员是一个明显的入口，点了整页是和它的对话 */}
        <div className="menu mem-keeper-wrap">
          <button type="button" className="mem-keeper-card" data-action="curator" onClick={() => navigate(memoryRoute("curator"))}>
            <span className="mem-keeper-icon" aria-hidden="true">
              <Icon name="chat" />
            </span>
            <span className="menu-text">
              <span className="mem-keeper-title">{t("pages.memory.keeper")}</span>
              <small>{memoryKeeperNightLine(summary)}</small>
              <small>{memoryKeeperInterviewLine(interview)}</small>
            </span>
            <span className="muted">›</span>
          </button>
        </div>
        <div className="menu memory-layers">
          {MEMORY_LAYERS.map((l) => (
            <button key={l} type="button" data-layer={l} className={`menu-item${on === l ? " on" : ""}`} onClick={() => navigate(memoryRoute(l))}>
              <span className="menu-text">
                <span>{LAYER_TITLE[l]}</span>
                <small>
                  <NamedText text={t(LAYER_SUB_KEY[l], { name: ASSISTANT_NAME_MARK })} />
                  {countText(l)}
                </small>
              </span>
              <span className="muted">›</span>
            </button>
          ))}
        </div>
        {/* 295 号票：数据源（设置下面的内核页面）：外面接进来的数据是素材的又一个来处，这里放个链接 */}
        <div className="menu memory-files-link">
          <button type="button" className="menu-item" data-page="data-sources" onClick={() => navigate({ tab: "more", page: "data-sources" })}>
            <span className="menu-text">
              <span>{t("pages.memory.dataSources")}</span>
              <small>{t("pages.memory.dataSourcesSub")}</small>
            </span>
            <span className="muted">›</span>
          </button>
        </div>
        {/* 336 号票：记忆的三个开关搬到了这里（原来在设置列表最下面），默认收起 */}
        <MemorySettingsSection />
      </div>
    </div>
  );
}

/** 一栏：档案自己排（标题栏上有"加一个人"）；别的是标题栏（素材的列表上有"成批删除"）和一整块滚动区 */
function MemoryLayerCol({ item, sub, navigate, onBack }: { item: Exclude<MemoryItem, "curator">; sub: string | undefined; navigate: Navigate; onBack: (() => void) | undefined }) {
  if (item === "files")
    return <PersonalFilesColumn title={LAYER_TITLE.files} item={sub} onBack={onBack} onOpen={(id) => navigate(memoryRoute("files", id))} onRemoved={() => goBackTo(memoryRoute("files"))} />;
  return (
    <div className="chat-col">
      <TopBar title={layerTitle(item, sub)} onBack={onBack}>
        {item === "materials" && sub === undefined && (
          <button type="button" className="btn small ghost" onClick={() => navigate(memoryRoute("materials-delete"))}>
            {t("pages.memory.bulkDelete")}
          </button>
        )}
      </TopBar>
      <div className="scroll page-pad">
        <LayerBody item={item} sub={sub} navigate={navigate} />
      </div>
    </div>
  );
}

function LayerBody({ item, sub, navigate }: { item: Exclude<MemoryItem, "curator" | "files">; sub: string | undefined; navigate: Navigate }) {
  switch (item) {
    case "materials":
      // 点开一条是再下一级；忘掉、彻底删除这一条后回到列表（不压新记录）
      return <MaterialsBrowse sub={sub} onOpen={(id) => navigate(memoryRoute("materials", id))} onClose={() => goBackTo(memoryRoute("materials"))} navigate={navigate} />;
    case "claims":
      // 285：点一条结论是它的证据链和竞争解释（233 号票的"证据与推理"并进来）；竞争解释里点一条换到它；那条不在了回到列表
      return sub === undefined ? (
        <ClaimsBrowse onOpen={(id) => navigate(memoryRoute("claims", id))} />
      ) : (
        <EvidenceBrowse sub={sub} onOpen={(id) => navigate(memoryRoute("claims", id))} onClose={() => goBackTo(memoryRoute("claims"))} />
      );
    case "questions":
      return <QuestionsBrowse />;
    case "materials-delete":
      return <MaterialsBulkDelete item={sub} onOpen={(id) => navigate(memoryRoute("materials-delete", id))} onClose={() => goBackTo(memoryRoute("materials-delete"))} navigate={navigate} />;
  }
}
