import type { ZoomMessage } from "./zoom-types.ts";

// Older senders could express an approval request only in the question itself.
// Match requests to make a decision, leaving factual questions about the process answerable.
const requestPatterns = [
  /(?:请(?:求|您|你|帮我)?|麻烦(?:您|你)?|烦请|需要(?:你|您|人工|负责人)|等待(?:你|您|人工|负责人)|由(?:你|您|人工)|是否(?:可以)?|能否|可否|能不能)(?:先|亲自|现在|正式|明确|直接|人工|帮我|给予|给我){0,3}(?:对.{1,20}?进行)?(?:审批|批准|授权|放行|签批|签字放行|签字确认|拍板|核准|同意)/u,
  /(?:申请|请求)(?:一次性|临时|例外|额外|人工|越权|生产发布|发布|上线|部署|管理员|写入)*(?:授权|批准|放行|权限)/u,
  /(?:需要|等待)(?:你|您|人工|负责人)的(?:审批|批准|授权|许可|同意)/u,
  /(?:你|您)(?:是否|能否|可否|可以)?(?:批准|审批|授权|放行|同意).{0,64}(?:吗|么|[?？])/u,
  /(?:能否|可否|是否(?:可以|允许|同意)?|可以|能不能|要不要我|允许我|同意我)(?:我|我们)?(?:先|现在|马上|直接|正式|立即|跳过审批|绕过审批)*(?:发布|上线|部署|合并|上架|投放|打款|付款|删除生产|开放.{0,16}权限|提权|越权|跳过审批|绕过审批)/u,
  /(?:请|需要(?:你|您)|等待(?:你|您))(?:人工)?确认(?:是否|可以|同意)?(?:放行|发布|上线|部署|合并|付款|越权)(?!时间|日期|记录|状态|日志|负责人)/u,
  /(?:请|能否|可否|可以|能)(?:给我|为我|帮我)(?:开通|授予|开放|提升|升级)?.{0,20}(?:权限|特权)/u,
  /^(?:人工审批|人工批准|审批请求|授权请求|例外授权|发布审批)(?:[：:？?]|$)/u,
  /^(?:批准|审批|授权|放行|同意|越权授权|发布授权)(?:吗|么|一下|这个|这次|此次|本次|我|我们|[?？:：]|$)/u,
  /\b(?:please|kindly|could you|can you|would you|will you|do you)\s+(?:(?:explicitly|manually|personally|formally)\s+)?(?:approve|authorize|authorise|grant (?:me |us )?(?:access|permission)|sign off|give (?:me |us )?(?:permission|the go-ahead))\b/i,
  /\b(?:request(?:ing)?|need|await(?:ing)?|waiting for|requires?)\s+(?:(?:your|human|explicit|manual|release|final|one-time)\s+)+(?:approval|permission|authorization|authorisation|sign[- ]off|go-ahead)\b/i,
  /\b(?:may|can|could|should) (?:i|we)\s+(?:(?:now|directly|go ahead and)\s+)?(?:release|publish|deploy|merge|ship|escalate privileges|bypass approval|proceed with (?:the |a )?(?:release|deployment))\b/i,
  /^(?:(?:is it )?(?:ok(?:ay)?|safe) (?:for (?:me|us) )?to|do (?:i|we) have (?:your )?permission to) (?:ship|release|deploy|publish|merge)\b/i,
  /^(?:approval|authorization|sign[- ]off) (?:requested|required|needed)(?:[ :?]|$)/i,
  /^(?:please\s+)?(?:approve|authorize|authorise|sign off on)\s+(?:this|the|our|my)\b/i,
];

const processQuestion =
  /^(?:请(?:帮我)?|麻烦|可以|能否|可否|能不能)?(?:解释|说明|介绍|描述|教我|告诉我|如何|怎么|谁来|在哪里|什么时候|我想知道|我想了解)|^(?:how\b|who\b|what\b|(?:please |(?:can|could|would) you )?(?:explain|describe|clarify|tell me)\b)/i;

export function requiresHumanApproval(message: Pick<ZoomMessage, "kind" | "body" | "requiresApproval">): boolean {
  if (message.kind !== "question") return false;
  if (message.requiresApproval) return true;
  return message.body
    .split(/[\n。；;，,]|[.!?]\s+|\s+and\s+(?=(?:please|can you|could you|approve|authorize)\b)/i)
    .some((raw) => {
      const clause = raw.trim();
      return !processQuestion.test(clause) && requestPatterns.some((pattern) => pattern.test(clause));
    });
}
