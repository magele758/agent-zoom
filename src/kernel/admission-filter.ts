/**
 * Deterministic pre-admission noise filter for candidate development signals and legacy
 * feature_admission decision packets. Prevents daily tech-news / Twitter / GitHub Trending
 * digest headings from flooding the Founder Approval Gateway as development proposals.
 */

const EXACT_NON_ACTIONABLE_TITLES = new Set([
  "待观察",
  "待确认",
  "其他",
  "补充",
  "备注",
  "目录",
  "总结",
  "概览",
  "数据概览",
  "重点精读",
  "重点信息摘要",
  "重点技术信号",
  "参考资料",
  "参考链接",
  "深度吸收",
  "今日主题判断",
  "今日核心新变量",
  "今日产物与飞书",
  "信息摘要",
  "技术学习补记",
  "行业与生态要闻",
  "行业与生态要闻速递",
  "每日大模型信息收集",
  "跨源共振",
  "一手规格与论文机制增量",
]);

const DIGEST_NOISE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /(?:twitter\s*双流|github\s*daily\s*trending|近\s*\d+\s*日飙升榜|飙升榜梳理|开源项目梳理|行业风向|生态速览|行业与生态要闻)/i,
    reason: "属于每日资讯/榜单汇总栏目，并非具体代码改动或研发需求",
  },
  {
    re: /(?:午后增量更新|早盘增补|晚间批次|晨间(?:增量更新|批次|增补)|周期性巡检(?:日报|汇总|批次)|相对\s*\d{2}:\d{2}.*批次增量|每日大模型信息收集|技术学习补记)/i,
    reason: "属于定时日报批次或学习补记标题，并非具体可开发的研发任务",
  },
  {
    re: /(?:重点精读|深度剖析|deep-dive\s*highlights|数据概览与去重基准|去重基准|跨源(?:概念)?共振|cross-source\s*reinforcement)/i,
    reason: "属于研报阅读/去重统计小节，缺少明确开发目标",
  },
  {
    re: /(?:今日出版包|数字花园归档|公开知识库归档|今日交付物与飞书|今日产物与飞书|今日公开发布主线|今日核心新变量|今日主题判断|一手核心信号|一手增量情报|一手规格与论文机制增量|重点信息摘要|重点技术信号)/i,
    reason: "属于出版归档或情报摘要标题，并非待立项的工程任务",
  },
  {
    re: /^[一二三四五六七八九十]+、\s*.*(?:技术学习|行业|精选|速览|补记|梳理|汇总)/i,
    reason: "属于带序号的资讯汇总章节标题，并非具体可开发的工程任务",
  },
  {
    re: /^(?:[一二三四五六七八九十]+、|\d+[.、])\s*(?:今日|重点|一手|跨源|github|twitter|出版|归档|动态|情报|速览|精选|数据概览|概览)/i,
    reason: "属于带序号的资讯文档章节标题，缺少明确工程动作",
  },
];

export function stripCandidateTitlePrefix(rawTitle: string): string {
  return rawTitle
    .replace(/^候选需求准入评估[:：]\s*/i, "")
    .replace(/^\*\*|\*\*$/g, "")
    .trim();
}

export function isDigestOrNonActionableNoise(
  rawTitle: string,
  _body = "",
): { noisy: boolean; reason?: string } {
  const title = stripCandidateTitlePrefix(rawTitle);
  if (!title) {
    return { noisy: true, reason: "标题为空，无法识别要开发什么" };
  }
  const normalized = title.toLowerCase();
  if (EXACT_NON_ACTIONABLE_TITLES.has(normalized) || title.length <= 3) {
    return { noisy: true, reason: "标题过于笼统（非具体研发动作），无法作为立项依据" };
  }
  for (const rule of DIGEST_NOISE_PATTERNS) {
    if (rule.re.test(title)) {
      return { noisy: true, reason: rule.reason };
    }
  }
  return { noisy: false };
}

export function cleanMarkdownPreview(text: string, maxLen = 160): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/[*_`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLen ? `${plain.slice(0, maxLen - 1)}…` : plain;
}
