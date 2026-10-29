// 设置 · 工作日规则（29 号票的工作日历页，35 号票起只留额外上班规则）：加删额外上班规则（每周几、每月第几个周几、每月最后一个周几）。
// 每天上班还是休息、为什么，以及把某天改成上班或休息、清掉标记，都在主导航的日历里看和改（这里有入口过去）。
// 改个人设置走 HTTP，守护进程改完在工作日历频道上推一条事件，打开着的页面（别的设备上的也一样）跟着变。
// 213 号票：日历是插件了，这一页（工作日规则、工作日判定）是内核的、照常；日历插件停用时不出去日历的链接，手动标记那句只说对秘书说。
import { useState } from "react";
import type { Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { MONDAY_FIRST, weekdayLabel } from "../../model/labels.ts";
import { useRouteAvailable } from "../../plugins/api.ts";
import { describeExtraRule, type ExtraWorkdayRule, t, type WorkdayChange, workdaySettingsOf } from "../../state/index.ts";
import { Section } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";
import { AssistantName } from "../../ui/assistant-name.tsx";
import { T } from "../../ui/i18n.tsx";

/** 每月第几个：第一个……第五个（按当前语言现取） */
const ORDINALS = ["pages.workdayRules.ordinal1", "pages.workdayRules.ordinal2", "pages.workdayRules.ordinal3", "pages.workdayRules.ordinal4", "pages.workdayRules.ordinal5"];

/** 加规则的下拉：写法和周几 */
type RuleKind = ExtraWorkdayRule["kind"];

function ruleFrom(kind: RuleKind, n: number, weekday: number): ExtraWorkdayRule {
  return kind === "nth_weekday" ? { kind, n, weekday } : { kind, weekday };
}

export function WorkdayRulesPage({ navigate }: { navigate: Navigate }) {
  const { ui, http } = useStore();
  const toast = useToast();
  const settings = workdaySettingsOf(ui);
  const [ruleKind, setRuleKind] = useState<RuleKind>("last_weekday");
  const [ruleN, setRuleN] = useState(1);
  const [ruleWeekday, setRuleWeekday] = useState(6);
  // 日历插件停用时（213 号票）没有去日历的入口
  const calendar = useRouteAvailable()({ tab: "calendar" });

  const change = (c: WorkdayChange) => {
    http.changeWorkday(c).catch((err: unknown) => toast(t("pages.workdayRules.failed", { reason: err instanceof Error ? err.message : String(err) })));
  };
  return (
    <>
      <div className="muted">{t("pages.workdayRules.formula")}</div>
      {calendar && (
        <div className="hint">
          <T
            k="pages.workdayRules.seeCalendar"
            params={{
              calendar: (
                <button type="button" className="link" onClick={() => navigate({ tab: "calendar" })}>
                  {t("pages.workdayRules.calendar")}
                </button>
              ),
            }}
          />
        </div>
      )}

      <Section title={t("pages.workdayRules.extraRules")}>
        {settings.rules.length === 0 && <div className="muted">{t("pages.workdayRules.none")}</div>}
        {settings.rules.map((r) => (
          <div key={describeExtraRule(r)} className="rule-item">
            <span>{describeExtraRule(r)}</span>
            <button type="button" className="link danger-text" onClick={() => change({ kind: "remove_rule", rule: r })}>
              {t("pages.workdayRules.delete")}
            </button>
          </div>
        ))}
        <div className="add-row">
          <select className="input" value={ruleKind} onChange={(e) => setRuleKind(e.target.value as RuleKind)} aria-label={t("pages.workdayRules.ruleKind")}>
            <option value="weekly">{t("pages.workdayRules.weekly")}</option>
            <option value="nth_weekday">{t("pages.workdayRules.nthWeekday")}</option>
            <option value="last_weekday">{t("pages.workdayRules.lastWeekday")}</option>
          </select>
          {ruleKind === "nth_weekday" && (
            <select className="input" value={ruleN} onChange={(e) => setRuleN(Number(e.target.value))} aria-label={t("pages.workdayRules.which")}>
              {ORDINALS.map((key, i) => (
                <option key={key} value={i + 1}>
                  {t(key)}
                </option>
              ))}
            </select>
          )}
          <select className="input" value={ruleWeekday} onChange={(e) => setRuleWeekday(Number(e.target.value))} aria-label={t("pages.workdayRules.weekday")}>
            {MONDAY_FIRST.map((d) => (
              <option key={d} value={d}>
                {weekdayLabel(d)}
              </option>
            ))}
          </select>
          <button type="button" className="btn primary small" onClick={() => change({ kind: "add_rule", rule: ruleFrom(ruleKind, ruleN, ruleWeekday) })}>
            {t("pages.workdayRules.add")}
          </button>
        </div>
        <div className="hint">
          {calendar ? (
            <T
              k="pages.workdayRules.manualHint"
              params={{
                calendar: (
                  <button type="button" className="link" onClick={() => navigate({ tab: "calendar" })}>
                    {t("pages.workdayRules.calendar")}
                  </button>
                ),
                name: <AssistantName />,
              }}
            />
          ) : (
            <T k="pages.workdayRules.manualHintNoCalendar" params={{ name: <AssistantName /> }} />
          )}
        </div>
      </Section>
      <div className="hint">{t("pages.workdayRules.holidayData")}</div>
    </>
  );
}
