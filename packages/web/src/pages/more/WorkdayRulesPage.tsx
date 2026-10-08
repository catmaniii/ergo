// 设置 · 工作日规则（29 号票的工作日历页，35 号票起只留额外上班规则）：加删额外上班规则（每周几、每月第几个周几、每月最后一个周几）。
// 每天上班还是休息、为什么，以及把某天改成上班或休息、清掉标记，都在主导航的日历里看和改（这里有入口过去）。
// 改个人设置走 HTTP，守护进程改完在工作日历频道上推一条事件，打开着的页面（别的设备上的也一样）跟着变。
import { useState } from "react";
import type { Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { MONDAY_FIRST, weekdayLabel } from "../../model/labels.ts";
import { describeExtraRule, type ExtraWorkdayRule, type WorkdayChange, workdaySettingsOf } from "../../state/index.ts";
import { Section } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

const ORDINALS = ["第一个", "第二个", "第三个", "第四个", "第五个"];

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

  const change = (c: WorkdayChange) => {
    http.changeWorkday(c).catch((err: unknown) => toast(`没改成：${err instanceof Error ? err.message : String(err)}`));
  };
  return (
    <>
      <div className="muted">你的上班日 = 新加坡工作日 ∪ 国内工作日（含调休补班）∪ 额外上班规则 ∪ 手动标记的上班日 − 手动标记的休息日。新加坡放假、国内上班的撞日算上班。</div>
      <div className="hint">
        每天上班还是休息、为什么，在
        <button type="button" className="link" onClick={() => navigate({ tab: "calendar" })}>
          日历
        </button>
        里看。
      </div>

      <Section title="额外上班规则">
        {settings.rules.length === 0 && <div className="muted">没有</div>}
        {settings.rules.map((r) => (
          <div key={describeExtraRule(r)} className="rule-item">
            <span>{describeExtraRule(r)}</span>
            <button type="button" className="link danger-text" onClick={() => change({ kind: "remove_rule", rule: r })}>
              删除
            </button>
          </div>
        ))}
        <div className="add-row">
          <select className="input" value={ruleKind} onChange={(e) => setRuleKind(e.target.value as RuleKind)} aria-label="规则的写法">
            <option value="weekly">每周</option>
            <option value="nth_weekday">每月第几个</option>
            <option value="last_weekday">每月最后一个</option>
          </select>
          {ruleKind === "nth_weekday" && (
            <select className="input" value={ruleN} onChange={(e) => setRuleN(Number(e.target.value))} aria-label="第几个">
              {ORDINALS.map((label, i) => (
                <option key={label} value={i + 1}>
                  {label}
                </option>
              ))}
            </select>
          )}
          <select className="input" value={ruleWeekday} onChange={(e) => setRuleWeekday(Number(e.target.value))} aria-label="周几">
            {MONDAY_FIRST.map((d) => (
              <option key={d} value={d}>
                {weekdayLabel(d)}
              </option>
            ))}
          </select>
          <button type="button" className="btn primary small" onClick={() => change({ kind: "add_rule", rule: ruleFrom(ruleKind, ruleN, ruleWeekday) })}>
            加上
          </button>
        </div>
        <div className="hint">
          某一天不上班或要上班（比如"下周一我不上班"）是手动标记，不是规则：在
          <button type="button" className="link" onClick={() => navigate({ tab: "calendar" })}>
            日历
          </button>
          里点那一天改；也可以对秘书说，它出一张快速动作卡，确认后标上。
        </div>
      </Section>
      <div className="hint">
        节假日数据是框架自带的公开数据（新加坡人力部、中国政府网）。每年 12 月检查一次下一年的数据，缺了在待我处理里提醒你，点一下发起联网任务去更新。
      </div>
    </>
  );
}
