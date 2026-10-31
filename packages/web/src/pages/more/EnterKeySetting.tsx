// 设置列表里的"发送和换行"（用户 2026-11-01 要的）：电脑上回车发送，换行用 Ctrl + 回车还是 Shift + 回车在这里选，只记在这台设备上。
// 触屏设备上不列：那里回车本来就是换行（state/composer-keys.ts）。
import { useSyncExternalStore } from "react";
import { isTouchDevice, pageNewlineKey } from "../../app/page-composer-keys.ts";
import { type NewlineKey, t } from "../../state/index.ts";
import { Segmented } from "../../ui/common.tsx";

export function EnterKeySetting() {
  const setting = pageNewlineKey();
  const current = useSyncExternalStore(setting.subscribe, setting.key, setting.key);
  if (isTouchDevice()) return null;
  const title = t("pages.enterKey.title");
  return (
    <div className="enter-key-setting">
      <div className="menu-text">
        {title}
        <small>{t("pages.enterKey.hint")}</small>
      </div>
      <Segmented<NewlineKey>
        role="radio"
        label={title}
        value={current}
        options={[
          { value: "ctrl", label: t("pages.enterKey.ctrl") },
          { value: "shift", label: t("pages.enterKey.shift") },
        ]}
        onChange={(next) => setting.set(next)}
      />
    </div>
  );
}
