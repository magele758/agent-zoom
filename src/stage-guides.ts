import type { ProductStageId } from "./product-stages.ts";
import type { StageWorkInput } from "./stage-work-types.ts";

export type StageDraft = Pick<StageWorkInput, "templateId" | "title" | "goal" | "inputs" | "deliverable" | "acceptance">;

export type StageAction = StageDraft & { label: string };
export type StageGuideDefinition = { purpose: string; actions: StageAction[] };

function action(templateId: string, label: string, brief: Omit<StageDraft, "templateId" | "title">): StageAction {
  return { templateId, label, title: label, ...brief };
}

export const stageGuides: Record<ProductStageId, StageGuideDefinition> = {
  research: {
    purpose: "最近观察到了哪些用户问题或市场变化？",
    actions: [
      action("research-feedback", "整理用户反馈", {
        goal: "从近期反馈中找出反复出现的使用障碍，标明发生场景。",
        inputs: "用户访谈、客服记录、社区讨论或相关 GitHub Issue。注明这次查看的时间范围。",
        deliverable: "一份问题清单。每项附一段用户原话或复现描述、来源链接和涉及的用户数。",
        acceptance: "同一用户的重复反馈只计一次。能从清单回到原文。证据不足的项单列。",
      }),
      action("research-lead", "核实一条外部线索", {
        goal: "把一条行业动态、社区讨论或一线观察核实成可以继续研究的问题。",
        inputs: "原文或观察记录、发生日期、关注这条线索的原因。",
        deliverable: "一张线索卡，附原始出处、受影响的人群、可交叉验证的事实和待追问的问题。",
        acceptance: "原文可核对，直接观察和转述分别注明，并指出值得进一步访谈或试验的对象。",
      }),
    ],
  },
  idea: {
    purpose: "哪一个想法值得先做小规模验证？",
    actions: [
      action("idea-compare", "比较两个产品方向", {
        goal: "围绕公司收集到的一个问题，比较两种可能的产品或内部工具方向。",
        inputs: "问题清单或原始反馈、两种候选解法、可用时间与约束。",
        deliverable: "一页取舍说明，列出两种方向各自服务谁、可能改善哪一步、最难验证的假设。",
        acceptance: "推荐项引用具体反馈。写清什么新证据会改变推荐，以及这次要负责人决定什么。",
      }),
      action("idea-validate", "设计最小验证", {
        goal: "把成本最高的一个假设改写成一次可以做完的小实验。",
        inputs: "候选想法、目标用户、可接触的验证对象和可用时间。",
        deliverable: "实验草案，含招募对象、测试动作、记录表和继续或停止的标准。",
        acceptance: "结果出来前就能判断什么算支持、什么算反例，且能指出由谁记录。",
      }),
    ],
  },
  prd: {
    purpose: "这次交付解决哪个场景，怎样算做完？",
    actions: [
      action("prd-scope", "写首版需求与范围", {
        goal: "把选定想法写成开发和测试能分别执行的首版需求。",
        inputs: "已选方向、真实用户场景、现有入口、技术或时间约束。",
        deliverable: "PRD 草案，含目标用户、主要流程、本期范围、暂缓项及验收清单。",
        acceptance: "每个本期需求都对应可观察的结果，未决问题有提问对象和具体选项。",
      }),
      action("prd-cases", "补齐边界与验收样例", {
        goal: "找出需求中不同人可能给出不同实现的地方，补成可核对的例子。",
        inputs: "当前 PRD 版本、既有行为、用户报告的异常或限制。",
        deliverable: "修订建议与验收表，列明前置条件、输入、操作和预期结果。",
        acceptance: "至少覆盖主路径、空数据和失败后重试。有关取舍的改动指向具体需求段落。",
      }),
    ],
  },
  design: {
    purpose: "用户从哪个入口开始，遇到失败又怎样继续？",
    actions: [
      action("design-prototype", "制作可点击原型", {
        goal: "针对一条核心用户路径制作可操作的界面草稿。",
        inputs: "PRD 中的路径和约束、现有界面或设计文件、目标屏幕尺寸。",
        deliverable: "可打开的原型和关键状态截图，覆盖入口、操作、成功与失败恢复。",
        acceptance: "给出原型入口和复查步骤。按步骤能到达预期结果，在窄屏也可完成主要操作。",
      }),
      action("design-review", "审阅现有设计稿", {
        goal: "沿 PRD 验收路径检查交互稿，指出会让用户中断或误解的细节。",
        inputs: "设计稿版本或原型入口、目标设备、待验收的任务场景。",
        deliverable: "带定位的评审意见，每项注明页面与状态、影响，以及可尝试的修订。",
        acceptance: "可以依据截图或设计节点逐条定位。待产品决定的取舍单列。",
      }),
    ],
  },
  development: {
    purpose: "这次改哪段行为，代码与验证结果放在哪里？",
    actions: [
      action("development-feature", "实现一个功能切片", {
        goal: "按已确认的一个用户场景，从正常入口交付可单独验证的小改动。",
        inputs: "目标仓库与基线、PRD 或 Issue、验收样例及修改范围。",
        deliverable: "变更差异、主要文件、验证命令及输出，附交给独立评审的说明。",
        acceptance: "差异对应所选场景。复跑命令得到预期结果。已知缺口和未运行的验证写明。",
      }),
      action("development-fix", "修复已确认的问题", {
        goal: "重现一个用户可见的问题，修复成因并验证相邻行为。",
        inputs: "原始 Issue 或复现记录、出错版本、最小输入与预期结果。",
        deliverable: "复现与修复前后对照、代码差异和回归检查记录。",
        acceptance: "同一最小输入能体现修复前后的变化，另有覆盖相关正常路径的结果。",
      }),
    ],
  },
  testing: {
    purpose: "独立检查能复现哪些结果，还有什么会挡住发布？",
    actions: [
      action("testing-regression", "独立复测改动", {
        goal: "从干净环境按验收条件复测一个候选版本，判断实际行为。",
        inputs: "候选提交或 PR、验收用例、运行环境和依赖。",
        deliverable: "逐项测试记录，含版本、命令或操作、实际输出、通过及失败项。",
        acceptance: "记录可供他人复跑。执行失败与环境阻塞分别记录。每个结论都有输出或截图。",
      }),
      action("testing-return", "整理可复现的返工单", {
        goal: "把一次失败验证还原成实现者能够直接动手的修正事项。",
        inputs: "原任务标识、失败日志或截图、版本、预期与实际结果。",
        deliverable: "与原任务关联的返工说明，包含最短复现步骤、影响范围和复测用例。",
        acceptance: "从记录能定位失败点，能重做同一项检查，保留失败时的原始证据。",
      }),
    ],
  },
  release: {
    purpose: "候选版本带了哪些变化，发布前还有什么待确认？",
    actions: [
      action("release-notes", "草拟版本说明", {
        goal: "根据两个版本间的实际差异，写一份使用者读得懂的变更说明。",
        inputs: "上一版本标签、候选提交、关联 PR、迁移说明和已知问题。",
        deliverable: "Release Notes 草稿，列出可见变化、升级步骤、兼容性和来源链接。",
        acceptance: "每项变化都能追溯到差异或 PR。需要用户采取的升级动作有具体步骤。",
      }),
      action("release-check", "核对发布条件", {
        goal: "检查候选版本的独立评审、测试和回退准备，交由负责人决定是否发布。",
        inputs: "候选版本、测试与评审证据、目标环境、上一可用版本。",
        deliverable: "发布前核对单，标出通过项、阻塞项、回退入口和待确认的决定。",
        acceptance: "所引证据均属于候选版本。能找到回退步骤、责任人和阻塞项的处理方式。",
      }),
    ],
  },
  operations: {
    purpose: "哪个仓库或服务需要维护，下一步该由谁处理？",
    actions: [
      action("operations-triage", "分诊未结 Issue 与 PR", {
        goal: "按用户影响和阻塞关系列出当前最需要处理的仓库事项。",
        inputs: "待维护的仓库、最近同步的开放 Issue 与 PR、已知里程碑或维护约束。",
        deliverable: "维护清单，每项附原链接、影响、建议处理顺序及下一步动作。",
        acceptance: "能回到原 Issue 或 PR 核对状态。重复事项已归并。资料不足的判断留为待确认。",
      }),
      action("operations-incident", "排查一次运行异常", {
        goal: "从最近一次异常开始，定位受影响的入口和首个失败环节。",
        inputs: "发生时间与时区、受影响的版本、可读取的日志或报警、近期变更。",
        deliverable: "事故时间线、证据引用和恢复建议，包含恢复后要验证的用户动作。",
        acceptance: "已观察事实与待验证原因分别写明。依据时间线能复查影响范围和恢复结果。",
      }),
    ],
  },
  trace: {
    purpose: "一次请求或任务经过了哪些步骤，时间和错误耗在哪里？",
    actions: [
      action("trace-request", "还原一次失败链路", {
        goal: "把一次失败请求或 agent 任务从发起到回执串成同一条时间线。",
        inputs: "请求、会话或任务标识、时间窗口、相关日志与执行回执。",
        deliverable: "带来源的调用时间线，附各步耗时、输入输出摘要、首次偏离预期的位置。",
        acceptance: "每个时间点有原始记录支撑，缺失环节明确标出，能按标识重新查到。",
      }),
      action("trace-compare", "比较两次运行", {
        goal: "用同一输入对照成功与失败或变更前后的运行，定位最早的差异。",
        inputs: "两次运行标识、版本、输入和允许对照的日志。",
        deliverable: "逐步差异表，含环境差异、耗时、回执与建议增加的观测点。",
        acceptance: "同类步骤按上下游关系对齐，能指出哪些差异已有证据、哪些还要补采。",
      }),
    ],
  },
  gtm: {
    purpose: "首批用户是谁，靠什么证据让他们愿意试用？",
    actions: [
      action("gtm-audience", "拟定首批用户与主张", {
        goal: "为一个明确的人群写清使用场景、当前替代做法和可验证的收益。",
        inputs: "用户访谈或反馈、产品可演示的能力、现有同类工具。",
        deliverable: "一页首发方案，含目标人群、价值主张、演示证据与待验证假设。",
        acceptance: "核心主张都能由演示或用户证据支撑，并列出可以先接触的用户类型。",
      }),
      action("gtm-launch", "设计首发试用计划", {
        goal: "选一个触达首批用户的渠道，安排从看到介绍到完成试用的路径。",
        inputs: "目标人群、候选渠道、演示或试用入口、时间与资源限制。",
        deliverable: "试用计划草案，列出介绍文案、行动入口、激活动作与观察时间。",
        acceptance: "可在既定资源内执行。记录方式和成功或停止条件在发布前可确认。",
      }),
    ],
  },
  acquisition: {
    purpose: "哪些渠道带来试用，用户又在哪里流失？",
    actions: [
      action("acquisition-funnel", "核对渠道到激活", {
        goal: "在同一观察窗口内，看各渠道各有多少用户完成一次有效激活。",
        inputs: "渠道标记、匿名客户标识、获客与激活时间、约定的激活动作。",
        deliverable: "各渠道去重人数与转化表，附原始事件引用及无法归因的记录。",
        acceptance: "分母和窗口一致。零分母有明确表示。抽取一位客户能追溯到对应记录。",
      }),
      action("acquisition-content", "准备一次推广实验", {
        goal: "给同一目标受众准备两个可对比的入口或文案，定义如何观察效果。",
        inputs: "受众描述、可用渠道、试用入口、已确认的产品主张。",
        deliverable: "两版推广草稿、各自的渠道标记、观察指标及复盘日期。",
        acceptance: "两版只改变计划验证的要素。点击后的目标动作和对应的记录方式清楚。",
      }),
    ],
  },
  revenue: {
    purpose: "哪些客户完成了首单、复购或退款？",
    actions: [
      action("revenue-orders", "核对首单与复购", {
        goal: "在指定产品内识别首单和第二笔独立订单，核对其客户来源。",
        inputs: "匿名客户标识、产品名、订单号、支付时间与状态、激活记录。",
        deliverable: "首单和复购客户表，含订单引用、对应渠道及缺少前置记录的订单。",
        acceptance: "重复通知不会增加订单数。能从一个复购客户还原两笔独立订单和时间。",
      }),
      action("revenue-refunds", "复核退款与实收差额", {
        goal: "找出一个周期内已支付、已退款和实收不一致的订单。",
        inputs: "指定周期、订单明细、退款记录和支付渠道结算记录。",
        deliverable: "按币种区分的订单核对表，列明退款、手续费及待核实差额。",
        acceptance: "每个差额可回到订单和支付凭据。缺少来源的金额保留待核实状态。",
      }),
    ],
  },
  accounting: {
    purpose: "本期每笔收支能对应哪张凭据，哪些差额尚未解释？",
    actions: [
      action("accounting-reconcile", "做月度收支对账", {
        goal: "把一个结算周期的交易、费用和实际到账逐笔对应起来。",
        inputs: "账期、已授权的脱敏流水、订单或费用清单、付款凭证。",
        deliverable: "按日期和币种整理的对账草表，逐笔关联合同、订单或凭证编号。",
        acceptance: "期初、期间变动和期末余额可核对。所有未匹配项有金额、理由和凭据线索。",
      }),
      action("accounting-evidence", "整理缺失凭证", {
        goal: "找出已记录但缺少来源凭据的收支，列出需要补充的材料。",
        inputs: "周期内的收支清单、已有票据或附件索引、可用的交易编号。",
        deliverable: "待补凭证清单，逐笔列明金额、缺少的材料、可核对来源和跟进对象。",
        acceptance: "重复票据单独标识。未找到凭证的项目保留原记录，供负责人复核。",
      }),
    ],
  },
};
