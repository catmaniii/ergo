# 新加坡与中国大陆的公众假期（2026–2027）

本文给二狗"个人工作日历"框架提供自带的假期数据。用户的工作日 = 新加坡工作日 ∪ 国内工作日（含调休补班）∪ 用户额外规则 − 手动休息。框架内置下面两国的官方假期和补班数据，用户只需要配置自己的额外规则和手动休息。

数据截至 2026-10-07，只取官方一手来源：新加坡人力部（MOM）网站及其在 data.gov.sg 上管理的数据集，以及中国政府网（gov.cn）。二手网站只用来找链接。每个日期都和官方原文核对过；"星期"一列由脚本按日期计算，再与原文标注的星期逐条比对，全部一致。

## 1. 来源

| # | 标题 | URL | 发布日期 | 访问日期 |
|---|---|---|---|---|
| S1 | MOM，Public holidays（2025/2026/2027 三年假期表） | https://www.mom.gov.sg/employment-practices/public-holidays | 页面标注 Last Updated 2026-06-19 | 2026-10-07 |
| S2 | MOM 新闻稿，Public Holidays for 2026 | https://www.mom.gov.sg/newsroom/press-releases/2025/0616-public-holidays-for-2026 | 2025-06-16（页面 Last Updated 2025-07-29） | 2026-10-07 |
| S3 | MOM 新闻稿，Public Holidays for 2027 | https://www.mom.gov.sg/newsroom/press-releases/2026/0618-public-holidays-for-2027 | 2026-06-18（页面 Last Updated 2026-07-23） | 2026-10-07 |
| S4 | MOM，Public holidays: entitlement and pay（周六、周日遇假日的处理规则） | https://www.mom.gov.sg/employment-practices/public-holidays-entitlement-and-pay | 页面标注 Last Updated 2025-07-30 | 2026-10-07 |
| S5 | MOM 年度日历文件（S1 页面上的 "Add … to your calendar" 链接） | https://www.mom.gov.sg/-/media/mom/documents/employment-practices/public-holidays/public-holidays-sg-2026.ics ；https://www.mom.gov.sg/-/media/mom/documents/employment-practices/public-holidays/public-holidays-sg-2027.ics | 文件未标注 | 2026-10-07 |
| S6 | data.gov.sg，Public Holidays for 2026（managedBy: Ministry of Manpower） | https://data.gov.sg/datasets/d_149b61ad0a22f61c09dc80f2df5bbec8/view | 创建 2025-06-16，更新 2026-07-03 | 2026-10-07 |
| S7 | data.gov.sg，Public Holidays for 2027（managedBy: Ministry of Manpower） | https://data.gov.sg/datasets/d_0ba69fc6d56717ff0bf8083c6af3bb84/view | 创建并更新于 2026-07-03 | 2026-10-07 |
| S8 | 国务院办公厅关于2026年部分节假日安排的通知（国办发明电〔2025〕7号） | https://www.gov.cn/zhengce/content/202511/content_7047090.htm | 2025-11-04 | 2026-10-07 |
| S9 | 同 S8，刊于 2025 年第 32 号国务院公报 | https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html | 2025-11-20 | 2026-10-07 |
| S10 | 国务院关于修改《全国年节及纪念日放假办法》的决定（附修订后全文） | https://www.gov.cn/zhengce/content/202411/content_6986380.htm | 2024-11-12（决定日期 2024-11-10，2025-01-01 起施行） | 2026-10-07 |
| S11 | 中国政府网"最新政策"列表（数据源 https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json） | https://www.gov.cn/zhengce/zuixin/ | 列表页，访问时最新一条为 2026-09-30 | 2026-10-07 |

S1、S2/S3、S5、S6/S7 的新加坡日期完全一致。S8 与 S9 的正文逐字相同。

## 2. 新加坡

规则（S4）：

- 假日落在**周日**（rest day）时，下一个工作日（即周一）为带薪公众假期，也就是下表的"补假 observed"。S1 的原话是 "Monday, … will be a public holiday if your rest day falls on …"，五天工作制下周日就是 rest day。
- 假日落在**周六**（五天工作制下的 non-working day）时**不顺延**。雇员可另得一天假，或一天工资代替，具体由雇主定，没有全国统一的补假日。所以框架不应给周六假日生成补假。
- 不受《雇佣法》（Employment Act）覆盖的雇员，按劳动合同执行。

### 2026 年（14 行：11 个公众假日 + 3 个补假）

| 日期 | 星期 | 名称 | 类型 |
|---|---|---|---|
| 2026-01-01 | 周四 | New Year's Day 元旦 | 假日 |
| 2026-02-17 | 周二 | Chinese New Year 农历新年 | 假日 |
| 2026-02-18 | 周三 | Chinese New Year 农历新年 | 假日 |
| 2026-03-21 | 周六 | Hari Raya Puasa 开斋节 | 假日 |
| 2026-04-03 | 周五 | Good Friday 耶稣受难日 | 假日 |
| 2026-05-01 | 周五 | Labour Day 劳动节 | 假日 |
| 2026-05-27 | 周三 | Hari Raya Haji 哈芝节 | 假日 |
| 2026-05-31 | 周日 | Vesak Day 卫塞节 | 假日 |
| 2026-06-01 | 周一 | Vesak Day (Observed) 卫塞节补假 | 补假 observed |
| 2026-08-09 | 周日 | National Day 国庆日 | 假日 |
| 2026-08-10 | 周一 | National Day (Observed) 国庆日补假 | 补假 observed |
| 2026-11-08 | 周日 | Deepavali 屠妖节 | 假日 |
| 2026-11-09 | 周一 | Deepavali (Observed) 屠妖节补假 | 补假 observed |
| 2026-12-25 | 周五 | Christmas Day 圣诞节 | 假日 |

说明：

- S2 当时把 Hari Raya Puasa 和 Hari Raya Haji 标为 "Subject to confirmation"。这两天都已经过去，S1（2026-06-19 更新）和 S6（2026-07-03 更新）上的日期仍是 03-21、05-27，可以视为定案。
- Hari Raya Puasa（03-21）落在周六，按上面的规则没有补假。
- 三个周一补假的日期出自 S2 的脚注（"Monday, 1 Jun 2026, will be a public holiday." 等）和 S1；S6 里对应的行名为 "… (Observed)"。

### 2027 年（12 行：11 个公众假日 + 1 个补假）

| 日期 | 星期 | 名称 | 类型 |
|---|---|---|---|
| 2027-01-01 | 周五 | New Year's Day 元旦 | 假日 |
| 2027-02-06 | 周六 | Chinese New Year 农历新年 | 假日 |
| 2027-02-07 | 周日 | Chinese New Year 农历新年 | 假日 |
| 2027-02-08 | 周一 | Chinese New Year (Observed) 农历新年补假 | 补假 observed |
| 2027-03-10 | 周三 | Hari Raya Puasa 开斋节 | 假日 |
| 2027-03-26 | 周五 | Good Friday 耶稣受难日 | 假日 |
| 2027-05-01 | 周六 | Labour Day 劳动节 | 假日 |
| 2027-05-17 | 周一 | Hari Raya Haji 哈芝节 | 假日 |
| 2027-05-20 | 周四 | Vesak Day 卫塞节 | 假日 |
| 2027-08-09 | 周一 | National Day 国庆日 | 假日 |
| 2027-10-28 | 周四 | Deepavali 屠妖节 | 假日 |
| 2027-12-25 | 周六 | Christmas Day 圣诞节 | 假日 |

说明：

- 农历新年落在周六、周日两天，只有周日那天顺延出一个周一补假（2027-02-08，出自 S3 脚注 "Monday, 8 Feb 2027, will be a public holiday."）。周六那天按规则不顺延。
- 02-06、05-01、12-25 三个周六假日都没有补假。
- S3 没有给伊斯兰节日加 "Subject to confirmation" 脚注（2026 年的 S2 加了）。

## 3. 中国大陆

### 2026 年（39 行：放假 33 天 + 调休上班 6 天）

S8 原文按节日写成"X月X日至X日放假调休，共N天。X月X日（周X）上班"。下表把每个放假区间逐日展开。每段展开后的天数都与原文"共N天"一致。

| 日期 | 星期 | 名称 | 类型 |
|---|---|---|---|
| 2026-01-01 | 周四 | 元旦（放假 1/3） | 假日 |
| 2026-01-02 | 周五 | 元旦（放假 2/3） | 假日 |
| 2026-01-03 | 周六 | 元旦（放假 3/3） | 假日 |
| 2026-01-04 | 周日 | 元旦调休上班 | 调休上班 |
| 2026-02-14 | 周六 | 春节调休上班 | 调休上班 |
| 2026-02-15 | 周日 | 春节（放假 1/9） | 假日 |
| 2026-02-16 | 周一 | 春节（放假 2/9） | 假日 |
| 2026-02-17 | 周二 | 春节（放假 3/9） | 假日 |
| 2026-02-18 | 周三 | 春节（放假 4/9） | 假日 |
| 2026-02-19 | 周四 | 春节（放假 5/9） | 假日 |
| 2026-02-20 | 周五 | 春节（放假 6/9） | 假日 |
| 2026-02-21 | 周六 | 春节（放假 7/9） | 假日 |
| 2026-02-22 | 周日 | 春节（放假 8/9） | 假日 |
| 2026-02-23 | 周一 | 春节（放假 9/9） | 假日 |
| 2026-02-28 | 周六 | 春节调休上班 | 调休上班 |
| 2026-04-04 | 周六 | 清明节（放假 1/3） | 假日 |
| 2026-04-05 | 周日 | 清明节（放假 2/3） | 假日 |
| 2026-04-06 | 周一 | 清明节（放假 3/3） | 假日 |
| 2026-05-01 | 周五 | 劳动节（放假 1/5） | 假日 |
| 2026-05-02 | 周六 | 劳动节（放假 2/5） | 假日 |
| 2026-05-03 | 周日 | 劳动节（放假 3/5） | 假日 |
| 2026-05-04 | 周一 | 劳动节（放假 4/5） | 假日 |
| 2026-05-05 | 周二 | 劳动节（放假 5/5） | 假日 |
| 2026-05-09 | 周六 | 劳动节调休上班 | 调休上班 |
| 2026-06-19 | 周五 | 端午节（放假 1/3） | 假日 |
| 2026-06-20 | 周六 | 端午节（放假 2/3） | 假日 |
| 2026-06-21 | 周日 | 端午节（放假 3/3） | 假日 |
| 2026-09-20 | 周日 | 国庆节调休上班 | 调休上班 |
| 2026-09-25 | 周五 | 中秋节（放假 1/3） | 假日 |
| 2026-09-26 | 周六 | 中秋节（放假 2/3） | 假日 |
| 2026-09-27 | 周日 | 中秋节（放假 3/3） | 假日 |
| 2026-10-01 | 周四 | 国庆节（放假 1/7） | 假日 |
| 2026-10-02 | 周五 | 国庆节（放假 2/7） | 假日 |
| 2026-10-03 | 周六 | 国庆节（放假 3/7） | 假日 |
| 2026-10-04 | 周日 | 国庆节（放假 4/7） | 假日 |
| 2026-10-05 | 周一 | 国庆节（放假 5/7） | 假日 |
| 2026-10-06 | 周二 | 国庆节（放假 6/7） | 假日 |
| 2026-10-07 | 周三 | 国庆节（放假 7/7） | 假日 |
| 2026-10-10 | 周六 | 国庆节调休上班 | 调休上班 |

说明：

- 中国没有新加坡式的"补假 observed"。周末遇到法定假日的补偿，已经折算进上面的放假区间和调休上班日里（S10 第六、七条），所以表中没有"补假"类型的行。
- 放假区间里混着三种日子：法定假日、本来就休的周末、调休换来的休息日。S8 没有逐日区分它们，表里统一记为"假日"。对工作日历来说，只需要知道哪天休、哪天上班。
- 调休上班日不一定是周六：2026-01-04 和 2026-09-20 都是**周日**上班。
- 9 月 20 日的上班日在原文中归在"国庆节"条目下，与中秋节无关。

### 2027 年：截至 2026-10-07 尚未公布

- 检查方法：中国政府网"最新政策"列表（S11）收录到 2026-09-30，里面没有 2027 年的节假日通知；网页搜索"国务院办公厅关于2027年部分节假日安排的通知"也只找到 2026 年的通知和第三方"预估"页面。本文不填写 2027 年的日期。
- 历年发布日期（均从 S11 列表核得）：

  | 适用年份 | 通知发布日期 | URL |
  |---|---|---|
  | 2021 | 2020-11-25 | https://www.gov.cn/zhengce/content/2020-11/25/content_5564127.htm |
  | 2022 | 2021-10-25 | https://www.gov.cn/zhengce/content/2021-10/25/content_5644835.htm |
  | 2023 | 2022-12-08 | https://www.gov.cn/zhengce/content/2022-12/08/content_5730844.htm |
  | 2024 | 2023-10-25 | https://www.gov.cn/zhengce/content/202310/content_6911527.htm |
  | 2025 | 2024-11-12 | https://www.gov.cn/zhengce/content/202411/content_6986382.htm |
  | 2026 | 2025-11-04 | https://www.gov.cn/zhengce/content/202511/content_7047090.htm |

- 预计：2027 年的通知大概在 **2026 年 10 月下旬到 12 月上旬**发布，最可能在 11 月。发布前，框架不应自行推算 2027 年的调休。2027 年可以先只按周末计算，并明确标出"国内假期未公布"。

### 新加坡 2028 年（顺带说明）

本文范围是 2026–2027，两年的新加坡数据都已公布。下一份是 2028 年的公告，参考 MOM 往年新闻稿的发布日期：2022 年假期于 2021-04-06 公布（https://www.mom.gov.sg/newsroom/press-releases/2021/0406-public-holidays-2022），2025 年假期于 2024-08-05 公布（https://www.mom.gov.sg/newsroom/press-releases/2024/0805-public-holidays-for-2025），2026 年假期于 2025-06-16 公布，2027 年假期于 2026-06-18 公布。据此，2028 年的公告预计在 **2027 年 4–8 月**，近两年都在 6 月中旬。

## 4. 更新方法

### 新加坡（每年约 6 月）

1. 去 MOM Newsroom 的 Press releases 找标题为 "Public Holidays for {下一年}" 的新闻稿。URL 形如 `https://www.mom.gov.sg/newsroom/press-releases/{当年}/{MMDD}-public-holidays-for-{下一年}`。补假写在新闻稿的脚注里（"Monday, … will be a public holiday."）。
2. 用 MOM 假期页 https://www.mom.gov.sg/employment-practices/public-holidays 核对。该页同时列出前一年、当年、下一年三年，并为每年提供 `.ics` 下载，路径为 `/-/media/mom/documents/employment-practices/public-holidays/public-holidays-sg-{年}.ics`。**注意：ICS 里没有周一补假**，导入后要按脚注或"周日顺延到周一"的规则补上。
3. 要机读数据，可以用 data.gov.sg 上由 MOM 管理的 "Public Holidays for {年}" 数据集。它的 `holiday` 字段已经包含 "… (Observed)" 行，可以通过 `https://data.gov.sg/api/action/datastore_search?resource_id={数据集ID}` 拉取。数据集 ID 每年不同（2026：`d_149b61ad0a22f61c09dc80f2df5bbec8`，2027：`d_0ba69fc6d56717ff0bf8083c6af3bb84`），要在 data.gov.sg 上按标题搜索。
4. 年中再看一次 MOM 假期页：
   - 政府可能临时增加公众假期。例如 S1 的 2025 年表格列有 Polling Day（2025-05-03，大选投票日）。
   - 新闻稿给伊斯兰节日标了 "Subject to confirmation" 时，节前也要核对最终日期。

### 中国大陆（每年 10–12 月）

1. 在中国政府网"最新政策" https://www.gov.cn/zhengce/zuixin/ 找《国务院办公厅关于{下一年}年部分节假日安排的通知》，文号形如"国办发明电〔{当年}〕N号"。程序化检查可以读 https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json，在 `TITLE` 里匹配"节假日安排"。之后同一文件还会刊登在国务院公报上（2026 年的通知是 16 天后，见 S9），可作备份来源。
2. 解析时：
   - 把每条"X月X日至X日放假调休，共N天"逐日展开为假日；
   - 把"X月X日（周X）上班"列为调休上班；
   - 校验每段天数等于"共N天"，每个日期的星期与原文括号里的一致。
3. 如果《全国年节及纪念日放假办法》再次修订（最近一次是 S10：2025 年起春节放假 4 天、劳动节 2 天，全体公民放假的节日共 13 天），也会在中国政府网发布。修订会改变各节日的天数，应同时复核。
