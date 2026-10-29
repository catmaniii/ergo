// 设置里的"我的名字"（249 号票，用户 2026-10-22："另外可以加一个我的名字的设置，让 agent 可以叫我的名字"）：
// 填的是**用户自己**的名字，和上面"个人助理的名字"（43 号票，那是用户给秘书起的）不是一回事；放在它旁边，两处说清。
// 存和取都走守护进程（GET/PUT /api/user-name，各设备一样），不进事件频道：打开页面时取一次（App.tsx 的 UserNameSync），
// 改完用接口回的那个。规则照 checkAssistantName（去掉首尾空白后 1–8 个字、不能有换行 / 控制字符 / ⟦⟧）：
// 不合规就地提示、不保存（守护进程同样会拒）。"清除"就是改回没设（删掉配置文件），界面和提示都回到现在的样子。
import { useState } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { useStore } from "../../app/store.tsx";
import { checkUserName, t, userNameOf } from "../../state/index.ts";

export function UserNameSetting() {
  const { ui, saveUserName } = useStore();
  const name = userNameOf(ui);
  /** 正在改的名字；没在改时输入框里是现在的名字（没设过就是空的） */
  const [draft, setDraft] = useState<string>();
  /** 守护进程拒了（或者没连上）的原因 */
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  // 鸿蒙 App 的系统返回键（62 号票）：改了一半没保存时先撤销这次修改，再按才离开设置
  useBackLayer("overlay", draft !== undefined && !busy, () => {
    setDraft(undefined);
    setFailed(undefined);
  });
  const value = draft ?? name ?? "";
  const checked = checkUserName(value);
  // 没设过时空着是可以的（就是没设）；填了才查
  const problem = failed ?? (value.trim() !== "" && !checked.ok ? checked.error : undefined);
  const changed = value.trim() === "" ? name !== undefined : checked.ok && checked.name !== name;

  const save = (raw: string) => {
    if (raw.trim() === "") {
      setBusy(true);
      saveUserName(null)
        .then(
          () => {
            setDraft(undefined);
            setFailed(undefined);
          },
          (err: unknown) => setFailed(t("pages.userName.failed", { reason: err instanceof Error ? err.message : String(err) })),
        )
        .finally(() => setBusy(false));
      return;
    }
    const result = checkUserName(raw);
    if (!result.ok) return setFailed(result.error);
    setBusy(true);
    saveUserName(result.name)
      .then(
        () => {
          setDraft(undefined);
          setFailed(undefined);
        },
        (err: unknown) => setFailed(t("pages.userName.failed", { reason: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form
      className="user-name-setting"
      // 说明不铺在页面上（一行就够了）：悬停看得到"这是你的名字，不是助理的"
      title={t("pages.userName.sub")}
      onSubmit={(e) => {
        e.preventDefault();
        save(value);
      }}
    >
      <span className="setting-label">{t("pages.userName.title")}</span>
      <input
        className="input"
        value={value}
        placeholder={t("pages.userName.placeholder")}
        aria-label={t("pages.userName.title")}
        aria-invalid={problem !== undefined}
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          setFailed(undefined);
        }}
      />
      <button type="submit" className="btn primary small" disabled={busy || !changed}>
        {t("pages.userName.save")}
      </button>
      {/* 没设过时"清除"点了也没事干，不占那一行的宽度（设置列表那一栏只有 280px，多了就折行） */}
      {name !== undefined && (
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => save("")}>
          {t("pages.userName.clear")}
        </button>
      )}
      {problem && (
        <div className="field-error" role="alert">
          {problem}
        </div>
      )}
    </form>
  );
}
