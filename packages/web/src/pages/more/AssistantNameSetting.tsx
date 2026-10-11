// 设置顶部的"个人助理的名字"（43 号票，规格第 19 节"名称"）：存在守护进程，各设备一样；改了以后守护进程在名字频道上推一条事件，
// 开着的页面（包括这台）都跟着变，秘书从下一轮起也按新名字。
// 规则（去掉首尾空白后 1–8 个字、不能有换行）由共享协议包的 checkAssistantName 查：不合规就地提示、不保存（守护进程同样会拒）。
// "恢复默认"就是改回默认的名字"二狗"（89 号票，用户 2026-10-11 定；原来是"个人助理"）。
import { useState } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { useStore } from "../../app/store.tsx";
import { checkAssistantName, DEFAULT_ASSISTANT_NAME } from "../../state/index.ts";
import { AssistantName, useAssistantName } from "../../ui/assistant-name.tsx";

export function AssistantNameSetting() {
  const { http } = useStore();
  const name = useAssistantName();
  /** 正在改的名字；没在改时输入框里是现在的名字 */
  const [draft, setDraft] = useState<string>();
  /** 守护进程拒了（或者没连上）的原因 */
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  // 鸿蒙 App 的系统返回键（62 号票）：改了一半没保存时先撤销这次修改（输入框回到现在的名字），再按才离开设置
  useBackLayer("overlay", draft !== undefined && !busy, () => {
    setDraft(undefined);
    setFailed(undefined);
  });
  const value = draft ?? name;
  const checked = checkAssistantName(value);
  const problem = failed ?? (draft !== undefined && !checked.ok ? checked.error : undefined);
  const changed = checked.ok && checked.name !== name;

  const save = (raw: string) => {
    const result = checkAssistantName(raw);
    if (!result.ok) return setFailed(result.error);
    setBusy(true);
    http
      .setAssistantName(result.name)
      .then(
        () => {
          setDraft(undefined);
          setFailed(undefined);
        },
        (err: unknown) => setFailed(`没改成：${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form
      className="assistant-name-setting"
      onSubmit={(e) => {
        e.preventDefault();
        save(value);
      }}
    >
      <div className="menu-text">
        个人助理的名字
        <small>
          各设备一样；界面上说到它的地方都用这个名字，它自己也知道。现在叫
          <AssistantName />
        </small>
      </div>
      <div className="assistant-name-row">
        <input
          className="input"
          value={value}
          aria-label="个人助理的名字"
          aria-invalid={problem !== undefined}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setFailed(undefined);
          }}
        />
        <button type="submit" className="btn primary" disabled={busy || !changed}>
          保存
        </button>
        <button type="button" className="btn ghost" disabled={busy || (name === DEFAULT_ASSISTANT_NAME && draft === undefined)} onClick={() => save(DEFAULT_ASSISTANT_NAME)}>
          恢复默认
        </button>
      </div>
      {problem && (
        <div className="field-error" role="alert">
          {problem}
        </div>
      )}
    </form>
  );
}
