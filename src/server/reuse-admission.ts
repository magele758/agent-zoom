import type { DatabaseSync } from "node:sqlite";
import type { Opportunity, OpportunityReuse } from "../autonomy-types.ts";
import type { RepoCapability } from "../repo-capabilities-types.ts";
import type { WorkflowPlan, WorkflowRequest, WorkflowReuseCheck } from "../workflow-types.ts";
import { ApiError } from "./logic.ts";
import { sameCapabilityFamily } from "./capability-identity.ts";

type RecordLink = {
  id: string;
  capabilityId: string;
  sourceId: string | null;
  ownerItem: string | null;
  satisfiesRequestId: string | null;
  satisfactionEvidence: string | null;
  satisfactionActor: string | null;
  deliveryRef: string | null;
  revision: number;
  status: string;
  consumer: string;
  title: string;
  detail: string;
};
const boundary = (value: string) =>
  new RegExp("(?<![a-z0-9_.-])" + value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9_.-])", "iu");
const key = (c: RepoCapability) => c.repo + "/" + c.name + "/" + c.version;
const locked = (message: string) => new ApiError(409, "capability_admission", message);
const planText = (plan?: WorkflowPlan) =>
  plan?.nodes.map((n) => n.title + "\n" + n.instruction).join("\n") ?? "";

// A registry hit needs an explicit version identity or the registered owner's full repository name.
// Ordinary words (and URLs attached only as source evidence to an imported candidate) do not reserve a capability.
export class ReuseAdmission {
  readonly capabilities: RepoCapability[];
  private records?: RecordLink[];
  constructor(private db: DatabaseSync) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opc_repo_capabilities'")
      .get();
    this.capabilities = exists
      ? (db
          .prepare(
            `SELECT id,product,project,repo,name,version,interface_ref AS interfaceRef,evidence
      FROM opc_repo_capabilities ORDER BY rowid`,
          )
          .all() as RepoCapability[])
      : [];
  }

  private links() {
    // Classification of a proposal only needs the public catalog. Read linked decisions once per queue snapshot.
    return (this.records ??= this.capabilities.length
      ? (this.db
          .prepare(
            `
      SELECT c.id,c.capability_id AS capabilityId,c.source_opportunity_id AS sourceId,s.request_id AS satisfiesRequestId, s.evidence AS satisfactionEvidence,s.actor AS satisfactionActor,s.delivery_ref AS deliveryRef,
        c.opportunity_id AS ownerItem,c.revision,v.status,c.product || '/' || c.project AS consumer,v.title,v.detail
      FROM opc_capability_requests c JOIN opc_capability_revisions v ON v.request_id=c.id AND v.revision=c.revision
      LEFT JOIN opc_capability_satisfaction s ON s.adoption_id=c.id ORDER BY c.rowid
    `,
          )
          .all() as RecordLink[])
      : []);
  }

  private groups(text: string, refs: string[] = []): Map<string, RepoCapability[]> {
    const groups = new Map<string, RepoCapability[]>();
    const pinnedRepos = new Set<string>();
    const family = (c: RepoCapability) => c.repo + "/" + c.name;

    for (const ref of refs) {
      if (
        !this.capabilities.some(
          (c) =>
            ref === c.id || ref === key(c) || ref === family(c) || ref.toLowerCase() === c.repo.toLowerCase(),
        )
      ) {
        throw locked("未登记的能力引用：" + ref);
      }
    }
    for (const c of this.capabilities) {
      if (
        refs.includes(c.id) ||
        refs.includes(key(c)) ||
        boundary(c.id).test(text) ||
        boundary(key(c)).test(text)
      ) {
        groups.set(c.id, [c]);
        pinnedRepos.add(c.repo);
      }
    }
    const mentioned = (repo: string) =>
      refs.some((r) => r.toLowerCase() === repo.toLowerCase()) || boundary(repo).test(text);
    for (const c of this.capabilities) {
      const id = family(c);
      if (groups.has(id)) continue;
      if (
        refs.includes(id) ||
        boundary(id).test(text) ||
        (!pinnedRepos.has(c.repo) && mentioned(c.repo) && boundary(c.name).test(text))
      ) {
        groups.set(
          id,
          this.capabilities.filter((other) => sameCapabilityFamily(c, other)),
        );
      }
    }
    for (const c of this.capabilities) {
      if (
        !mentioned(c.repo) ||
        groups.has(c.repo) ||
        [...groups.values()].some((group) => group[0].repo === c.repo)
      )
        continue;
      groups.set(
        c.repo,
        this.capabilities.filter((other) => other.repo === c.repo),
      );
    }
    return groups;
  }

  declaredRefs(text: string, refs: string[] = []) {
    return [...new Set([...refs, ...this.groups(text, refs).keys()])];
  }

  reviewCheck(text: string, scope?: "adopted" | "upstream"): WorkflowReuseCheck {
    const tokens = (s: string) =>
      new Set(
        [...new Intl.Segmenter("zh", { granularity: "word" }).segment(s.toLowerCase())]
          .filter((t) => t.isWordLike && t.segment.length >= 2)
          .map((t) => t.segment),
      );
    const words = tokens(text);
    const suggestions = this.capabilities
      .map((c) => {
        const terms = tokens(c.name + " " + c.interfaceRef);
        const common = [...terms].filter((t) => words.has(t));
        return { cap: c, score: text.includes(c.name) ? 100 : common.length >= 2 ? common.length : 0 };
      })
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((i) => i.cap);
    const inspection =
      "先核对目录或随任务提供的版本与接口；需要扩展检索时，使用 opc-os capability discover <关键词> --owner <开源库账号> 查找并验证公开库。";
    const action =
      scope === "upstream"
        ? "本计划已绑定原仓需求审批版本，核对获批范围、原有接口与兼容性。"
        : scope === "adopted"
          ? "本计划已绑定采用记录，按记录中的版本、接口与验收条件集成到消费项目。"
          : "发现匹配时先登记采用版本或向原仓提需求。若已经开工，先停下重复实现，在原任务回执记录匹配依据、原仓链接及后续采用或需求记录。";
    return {
      command: "opc-os capability list",
      instruction: inspection + action + "独立评审核对调用证据或未命中的依据。",
      suggestions,
    };
  }

  static pendingOwnerItems(db: DatabaseSync): string[] {
    if (
      !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opc_capability_requests'").get()
    )
      return [];
    return db
      .prepare(
        `SELECT o.id FROM opc_opportunities o JOIN opc_capability_requests r ON o.id=r.opportunity_id
      JOIN opc_capability_revisions v ON v.request_id=r.id AND v.revision=r.revision
      WHERE o.state='queued' AND v.status='approved' ORDER BY o.created_at,o.id`,
      )
      .all()
      .map((row) => String(row.id));
  }

  inspect(item: Opportunity): OpportunityReuse | undefined {
    const records = this.links();
    const owner = records.find(
      (r) =>
        r.ownerItem === item.id &&
        r.status === "approved" &&
        item.sourceId === "capability-gap/" + r.id + "/r" + r.revision,
    );
    if (owner) {
      const cap = this.capabilities.find((c) => c.id === owner.capabilityId)!;
      return {
        status: "upstream",
        capabilities: [cap],
        requestIds: [owner.id],
        approval: {
          requestId: owner.id,
          revision: owner.revision,
          consumer: owner.consumer,
          title: owner.title,
          detail: owner.detail,
        },
      };
    }
    const links = records.filter((r) => r.sourceId === item.id);
    if (item.state !== "queued" && !links.length) return;
    const groups = [...this.groups(item.title + "\n" + item.rationale, item.capabilityRefs).values()];
    // A person may recognize a capability in a loosely worded candidate that has no textual identifier.
    for (const link of links) {
      const cap = this.capabilities.find((c) => c.id === link.capabilityId);
      if (cap && !groups.some((group) => group.length === 1 && group[0].id === cap.id)) groups.push([cap]);
    }
    if (!groups.length) return;
    const adopted = new Set(links.filter((r) => r.status === "reused").map((r) => r.capabilityId));
    const fulfilled = new Set<string>();
    for (const record of links.filter((r) => r.status === "reused" && r.satisfiesRequestId)) {
      const gap = links.find((r) => r.id === record.satisfiesRequestId && r.status === "approved");
      const original = this.capabilities.find((c) => c.id === gap?.capabilityId);
      const successor = this.capabilities.find((c) => c.id === record.capabilityId);
      // The consumer explicitly confirmed the fixed alternative against this approved gap, with its delivery evidence.
      if (
        original &&
        successor &&
        original.id !== successor.id &&
        sameCapabilityFamily(original, successor)
      ) {
        fulfilled.add(original.id);
      }
    }
    const covered = groups.every((group) => group.some((c) => adopted.has(c.id) || fulfilled.has(c.id)));
    const anyPending = links.some((r) => r.status === "pending" || r.status === "changes");
    const status = covered && !anyPending ? "adopted" : "needs_decision";
    const ids = new Set(groups.flat().map((c) => c.id));
    return {
      status,
      capabilities: this.capabilities.filter(
        (c) => ids.has(c.id) && (status !== "adopted" || adopted.has(c.id)),
      ),
      requestIds: links.map((r) => r.id),
      ...(status === "adopted" && {
        adoptions: links
          .filter((r) => r.status === "reused")
          .map((r) => ({
            requestId: r.id,
            revision: r.revision,
            consumer: r.consumer,
            title: r.title,
            detail: r.detail,
            ...(r.satisfiesRequestId && {
              replacement: {
                requestId: r.satisfiesRequestId,
                evidence: r.satisfactionEvidence!,
                actor: r.satisfactionActor!,
                deliveryRef: r.deliveryRef!,
              },
            }),
          })),
      }),
    };
  }

  assertDirect(
    request: Pick<WorkflowRequest, "goal" | "constraints" | "context" | "plan" | "capabilityRefs">,
  ) {
    const groups = this.groups(
      [request.goal, request.context, ...request.constraints, planText(request.plan)].join("\n"),
      request.capabilityRefs,
    );
    if (!groups.size) return;
    const cap = [...groups.values()][0][0];
    throw locked(
      "已登记开源能力 " +
        cap.repo +
        " / " +
        cap.name +
        "。请把需求登记为研发候选，在 #capabilities?capability=" +
        cap.id +
        " 关联采用版本或申请原仓补齐；之后可用 workflow submit 提交仅含 opportunityId 的 JSON。",
    );
  }
}

export function reuseRequest(
  item: Opportunity,
  request: WorkflowRequest,
  reuse: OpportunityReuse,
): WorkflowRequest {
  if (reuse.status === "needs_decision")
    throw locked("先在开源能力目录选择采用版本，或提交原仓缺口等待审批。");
  const owner = reuse.status === "upstream";
  const refs = reuse.capabilities.map(
    (c) => c.repo + " / " + c.name + " @ " + c.version + " · " + c.interfaceRef,
  );
  const goal = owner
    ? "在维护项目补齐已批准的能力缺口：" + reuse.approval!.title
    : "在消费项目接入已登记的能力：" + item.title;
  const instruction = owner
    ? "在该维护仓库实现获批的缺口，并验证现有接口的兼容性。"
    : "仅在消费项目调用已登记版本的原仓接口并做集成验证。保留提供方实现；如果现有版本不足，记录缺口并退回到原仓需求。";
  const review = owner
    ? "独立核对原仓需求、兼容性、差异和测试输出。"
    : "独立确认使用登记版本的原仓接口，核对调用路径、版本与测试。发现消费项目重复实现提供方能力时退回。";
  const approval = reuse.approval;
  const context = approval
    ? `原仓需求 #capabilities?request=${approval.requestId} · 已批准 r${approval.revision} · 采用项目 ${approval.consumer}\n${approval.title}\n${approval.detail}`
    : request.context;
  const adoptions = (reuse.adoptions ?? []).map(
    (record) =>
      `采用记录 #capabilities?request=${record.requestId} · r${record.revision} · ${record.consumer}\n${record.title}\n${record.detail}`,
  );
  const resolutions = (reuse.adoptions ?? []).flatMap((record) =>
    record.replacement
      ? [
          `对应已批准的原仓缺口 #capabilities?request=${record.replacement.requestId} · 确认人 ${record.replacement.actor}\n原仓交付：${record.replacement.deliveryRef}`,
          `验证依据：${record.replacement.evidence}`,
        ]
      : [],
  );
  const documents = [
    ...request.constraints,
    ...(owner ? [request.context] : []),
    ...adoptions,
    ...resolutions,
    ...refs,
    ...reuse.capabilities.map((c) => c.evidence),
    instruction,
  ];
  const constraints: string[] = [];
  for (const source of documents) {
    if (source.length > 4000) throw locked("单份采用资料超出计划容量，请按交付范围拆为多个候选");
    const last = constraints.length - 1;
    if (last < 0 || constraints[last].length + 1 + source.length > 4000) constraints.push(source);
    else constraints[last] += "\n" + source;
  }
  if (constraints.length > 12) throw locked("本项涉及的接口资料超过计划容量，请按交付范围拆为多个候选。");
  return {
    ...request,
    goal,
    context,
    constraints,
    plan: {
      nodes: [
        {
          id: "implement",
          kind: "implement",
          title: owner ? "补齐原仓能力" : "接入原仓接口",
          instruction,
          dependsOn: [],
        },
        {
          id: "review",
          kind: "review",
          title: "独立复核能力合同",
          instruction: review,
          dependsOn: ["implement"],
        },
      ],
      acceptance: ["review"],
    },
  };
}
