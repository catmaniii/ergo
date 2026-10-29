// 设置 · 更多 · 体检（319 号票的 319b）：地址 #/more/doctor，一行一项，八项从上到下——
// ✅ / ⚠️、这一项的名字、查出来的事实（按当前语言拼：端口号、版本号、剩多少 GB）、坏了的时候一句"怎么修"；
// 右上"再查一遍"（重新请求 GET /api/doctor）；底下写着查的时刻。演示页用编好的假数据。
// 每项查什么、ok 怎么判都在守护进程（packages/daemon/src/doctor/doctor.ts）；形状在共享协议包的 doctor.ts；
// 事实拼句和"怎么修"的文案在 app/doctor.ts，中英文案在 locales/*/doctor.json。
// 列表（DoctorList）是纯渲染，测试在 Node 里直接渲染。
import { doctorAtText, doctorCheckTitle, doctorFactText, doctorFixText } from "../../app/doctor.ts";
import { useDoctor } from "../../app/page-doctor.ts";
import { type DoctorCheckView, type DoctorView, t } from "../../state/index.ts";
import { TopBar } from "../../ui/common.tsx";

/** 一项：打头是 ✅ 还是 ⚠️，然后是名字、事实、怎么修（健康时没有最后一句） */
export function DoctorCheckRow({ check }: { check: DoctorCheckView }) {
  const fix = doctorFixText(check);
  return (
    <li className={`doctor-row ${check.ok ? "doctor-ok" : "doctor-warn"}`} data-check={check.id}>
      <span className="doctor-mark" aria-hidden="true">
        {check.ok ? "✅" : "⚠️"}
      </span>
      <span className="doctor-name">{doctorCheckTitle(check.id)}</span>
      <span className="doctor-fact">{doctorFactText(check)}</span>
      {fix !== undefined && <span className="doctor-fix">{fix}</span>}
    </li>
  );
}

/** 八项（顺序照守护进程给的，也就是协议包的 DOCTOR_CHECKS） */
export function DoctorList({ view }: { view: DoctorView }) {
  return (
    <ul className="doctor-list">
      {view.checks.map((check) => (
        <DoctorCheckRow key={check.id} check={check} />
      ))}
    </ul>
  );
}

/** 设置 · 更多里的体检页：标题栏右上"再查一遍"，底下是八项和查的时刻 */
export function DoctorPage({ title, onBack }: { title: string; onBack: (() => void) | undefined }) {
  const { view, loading, error, recheck } = useDoctor();
  return (
    <div className="chat-col">
      <TopBar title={title} onBack={onBack}>
        <button type="button" className="btn ghost small" data-action="recheck" disabled={loading} onClick={recheck}>
          {loading ? t("doctor.rechecking") : t("doctor.recheck")}
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <div className="doctor-page">
          <div className="doctor-intro muted">{t("doctor.intro")}</div>
          {view === undefined && error === undefined && <div className="muted">{t("doctor.loading")}</div>}
          {error !== undefined && (
            <div className="field-error" role="alert">
              {t("doctor.loadFailed", { reason: error })}
            </div>
          )}
          {view !== undefined && (
            <>
              <div className="doctor-at muted">{doctorAtText(view)}</div>
              <DoctorList view={view} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
