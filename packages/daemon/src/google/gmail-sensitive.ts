// 导入的"我发出的邮件"按每封写窄敏感类别（298 号票，主会话 2026-10-26 定；303 号票的"敏感类别按记录写窄"）：
// 用简单的关键词判断，正文（主题加去掉引用的正文）里**明显**是财务或健康的标上对应类别，判不准的不标，其余都不标（sensitive: []）。
// - 财务 finance：账单、转账、汇款、工资 / 薪资 / 薪水 / 奖金、报价、发票、报销、付款 / 收款 / 还款 / 退款、贷款、信用卡；
//   英文 invoice、billing、payment、salary、payroll、quotation / price quote、wire / bank transfer、refund、reimbursement；
// - 健康 health：生病 / 病了 / 看病 / 病情 / 病假、住院、医院、医生、门诊、挂号、吃药 / 开药 / 药物 / 处方、体检、化验、手术、发烧、感冒；
//   英文 hospital、doctor、clinic、prescription、medication、medical、check-up、sick leave、diagnosis。
// 只认整词、不认单字（"病""药"单独出现太容易误判，"毛病""芍药"不算；英文按整个词，"Bill"这种人名不算）。
// 标上的类别没打开推断时整封不读成证据（记忆的敏感类别开关，默认都没打开）；数据源登记的敏感类别是这两类（页面上写明）。
// 判断在同步时做、写进事件负载（采集规则只看事件本身，ADR-0006）。
import type { SensitiveCategory } from "../config/config.ts";

// @i18n-ignore-start data：认邮件正文里中英文的关键词（不是界面文字）
const FINANCE = /账单|转账|汇款|工资|薪资|薪水|奖金|报价|发票|报销|付款|收款|还款|退款|贷款|信用卡|\b(?:invoices?|billing|payments?|salary|salaries|payroll|quotation|price quote|wire transfer|bank transfer|refunds?|reimburse(?:ment)?)\b/i;
const HEALTH = /生病|病了|看病|病情|病假|住院|医院|医生|门诊|挂号|吃药|开药|药物|处方|体检|化验|手术|发烧|感冒|\b(?:hospital|doctors?|clinic|prescriptions?|medication|medical|check-?up|sick leave|diagnos(?:is|ed))\b/i;
// @i18n-ignore-end

/** 这封发出的邮件落在哪些敏感类别（判不准的不标） */
export function sentMailSensitive(text: string): SensitiveCategory[] {
  return [...(FINANCE.test(text) ? (["finance"] as const) : []), ...(HEALTH.test(text) ? (["health"] as const) : [])];
}

/** 数据源登记的敏感类别（页面上写明这几类默认只记录、不用于推断） */
export const GMAIL_SENSITIVE: readonly SensitiveCategory[] = ["finance", "health"];
