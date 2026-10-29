// 生日、纪念日的每年提醒建在提醒插件里（283 号票）：经插件宿主按名字取提醒的服务（reminders/api.ts 的 REMINDERS），拼成档案要的
// AnnualReminderPort（建、改、删、取；经手人写用户）。插件没启用时取到 undefined，档案页写"提醒插件没启用"，起来时补建。
// 302 号票从组合根挪到这里：组合根里不出现提醒（test/reminders/boundary.test.ts，126 号票），283 合进来时在 daemon.ts 里拼的这一段破了它。
import type { ServiceKey } from "../plugins/host.ts";
import { REMINDERS } from "../reminders/api.ts";
import type { AnnualReminderPort } from "./annual.ts";

/** 组合根交来的插件宿主（只用得上按名字取服务） */
export interface PluginServices {
  service<T>(key: ServiceKey<T>): T | undefined;
}

/** 个人档案的选项 annual：每次现取（插件随时可能停用、启用） */
export function annualPortOf(plugins: PluginServices): () => AnnualReminderPort | undefined {
  return () => {
    const reminders = plugins.service(REMINDERS);
    if (!reminders) return undefined;
    return {
      create: (input) => ({ id: reminders.create(input, "user").reminder.id }),
      update: (id, input) => void reminders.update(id, input, "user"),
      remove: (id) => void reminders.remove(id, "user"),
      get: (id) => {
        const reminder = reminders.get(id);
        return reminder && { status: reminder.status, text: reminder.text, ...(reminder.schedule === undefined ? {} : { schedule: reminder.schedule }), ...(reminder.nextAt === undefined ? {} : { nextAt: reminder.nextAt }) };
      },
    };
  };
}
