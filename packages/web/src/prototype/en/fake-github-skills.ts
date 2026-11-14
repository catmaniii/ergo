// fake-github-skills.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_GITHUB_SKILLS: Phrases = {
  "记习惯、到点提醒打卡（假数据）": "Track habits and get check-in reminders (demo data)",
  "把会议录音整理成纪要（假数据）": "Turn meeting recordings into minutes (demo data)",
  "SKILL.md 开头没有 frontmatter（---）": "SKILL.md doesn't start with frontmatter (---)",
  "整理引用、生成参考文献（假数据）": "Tidy citations and build a reference list (demo data)",
  "先写测试再写代码（假数据）": "Write the tests before the code (demo data)",
  "集合 demo-methods 里的 demo-tdd": "demo-tdd in collection demo-methods",
  "先列提纲再动笔（假数据）": "Outline first, then write (demo data)",
  "把初稿润色干净（假数据）": "Polish a first draft (demo data)",
  "一套写作和查资料用的 skill（假数据）": "A set of skills for writing and research (demo data)",
  "认不出这个地址：{}。要填 GitHub 上公开仓库的地址": "Can't recognize this address: {}. Enter the address of a public GitHub repository",
  "GitHub 上找不到 {}：地址写错了，或者是私有仓库（现在只支持公开仓库）": "Can't find {} on GitHub: the address is wrong, or it's a private repository (only public repositories are supported for now)",
};
