export type ExecutiveReceiptInput = {
  status: string;
  report: string;
  evidence?: readonly string[];
  deliveryUnavailable?: boolean;
};

export type ExecutiveReceiptSummary = {
  statusLabel: string;
  conclusion: string | null;
  recommendation: string | null;
  evidence: string[];
  citedEvidence: string[];
  gap: string | null;
};

const statuses: Record<string, string> = {
  completed: "已完成", failed: "执行失败", error: "执行失败", cancelled: "已取消", canceled: "已取消",
  queued: "排队中", pending: "待执行", running: "执行中", working: "执行中", in_progress: "执行中",
  waiting_approval: "等待审批", blocked: "执行受阻", unknown: "状态待核对",
};

type Section = "conclusion" | "recommendation" | "citedEvidence";

const fields: Array<[Section, RegExp]> = [
  ["conclusion", /^(?:结论|最短结论|结果|执行结果|本次结果|(?:执行|核查|核对|验证|最终|本次)结论|(?:验证|核查|核对|检查)结果|result|conclusion)(?:\s*[：:。]\s*|$)/i],
  ["recommendation", /^(?:(?:Bot |我的|处理|本次|审批)?建议|推荐方案|建议你?在原事项(?:里)?(?:回复|选)|建议的下一步(?:，仍需你在原事项批准后才做)?|recommendation)(?:\s*[：:]\s*|$)/i],
  ["citedEvidence", /^(?:证据|证据引用|核查依据|可核对的证据|已核对的证据|刚核到的(?:证据|现场)|evidence)(?:\s*[：:]\s*|$)/i],
];

const planOnly = /^(?:(?:我|我们|本次|这次|接下来|下一步)(?:会|将|准备|先|计划)|(?:先|将|计划|准备|打算|请)(?:核对|核查|检查|验证|排查|查看|读取|执行)|(?:I|we)(?:'ll| will| plan to)\b)/i;
const missing = /^(?:无|暂无|未提供|未附|未记录|待补(?:充)?|待核对|待验证|none|unknown|n\/a)[。.!！]?$/i;
const locator = /(?:https?:\/\/\S|[\w./-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|sql|log|jsonl?|md|ya?ml|html|css|sh)(?:\b|$)|(?:^|[^\w])[\da-f]{7,40}(?!\w)|(?:PR|Issue|commit|run|工单|提交|日志|版本)\s*[#：:]?\s*[a-z\d][\w.-]*|[\w.-]+\/[\w.-]+#\d+)/i;

function plainLine(line: string) {
  return line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*[-*+]\s+/, "")
    .replace(/(`+[^`\n]*`+)|(?<![\/\w])\*\*([^*\n]+?)\*\*(?![\/\w])/g,
      (match, code: string | undefined, emphasis: string | undefined) => code ?? emphasis ?? match).trim();
}

/** Pull explicit fields from the Bot's last report segment. Its prose never supplies a decision target or a grant. */
export function summarizeExecutiveReceipt(input: ExecutiveReceiptInput): ExecutiveReceiptSummary {
  const status = input.status.toLowerCase();
  const evidence = [...new Set((input.evidence ?? []).map(s => s.trim()).filter(Boolean))];
  const citedEvidence: string[] = [];
  let conclusion: string | null = null;
  let recommendation: string | null = null;
  let section: Section | null = null;
  let fence: string | null = null;
  let finalLines: string[] = [];
  let nextWrite = false;
  for (const raw of input.report.split(/\r?\n/)) {
    const text = raw.trim();
    const mark = /^(?:`{3,}|~{3,})/.exec(text)?.[0];
    if (mark) {
      if (!fence) fence = mark;
      else if (mark.startsWith(fence)) fence = null;
      continue;
    }
    if (fence || !text || /^ {4}|^\t/.test(raw) || text.startsWith(">")) continue;
    // Agent Home places these markers between successive writes to a report.
    if (/^\[written \d{4}-\d\d-\d\d[^\]\n]*\]$/.test(text)) { nextWrite = true; continue; }
    if (nextWrite) { finalLines = []; nextWrite = false; }
    finalLines.push(text);
  }
  for (const text of finalLines) {
    let value = plainLine(text);
    const field = fields.find(([, label]) => label.test(value));
    if (field) {
      section = field[0];
      if (section === "conclusion") conclusion = null;
      if (section === "recommendation") recommendation = null;
      value = value.replace(field[1], "").trim();
      if (!value) continue;
    } else if (/^#{1,6}\s|^[^：:\n]{1,48}[：:]$|^\*\*[^*]+\*\*$/.test(text)) {
      section = null;
    }

    if (!section) continue;
    if (section === "citedEvidence") {
      if (!field && !/^[-*+]\s|^\d+[.)、]\s*/.test(text)) { section = null; continue; }
      if (locator.test(value) && !planOnly.test(value) && citedEvidence.length < 3 && !citedEvidence.includes(value))
        citedEvidence.push(value);
    } else {
      if (!missing.test(value) && (section === "recommendation" || !planOnly.test(value))) {
        if (section === "conclusion") conclusion = value;
        else recommendation = value;
      }
      section = null;
    }
  }

  const gaps: string[] = [];
  if (status !== "completed") {
    if (status === "cancelled" || status === "canceled") gaps.push("任务已取消，未交付最终结论。");
    else if (status === "failed" || status === "error") gaps.push("执行失败，未交付最终结论。");
    else gaps.push("尚无已完成的交付。");
    conclusion = null;
  } else if (!conclusion) gaps.push("报告未单列执行结论。");
  if (input.deliveryUnavailable) gaps.push("暂未读取到完整的交付附件与工具回执。");
  else if (!evidence.length && !citedEvidence.length) gaps.push("本回执未附可核对的证据。");
  return {
    statusLabel: statuses[status] ?? "状态待核对", conclusion, recommendation,
    evidence, citedEvidence, gap: gaps.length ? gaps.join("") : null,
  };
}
