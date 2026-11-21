import { productStages, type ProductStageId } from "../../src/product-stages";
import type { ZoomMessage } from "../../src/zoom-types";

export const companyDepartments = [
  { page: "commercial", name: "商业与治理部", icon: "growth", description: "统筹 7 层资产地图、1 号变现试点、收银离线授权、门面合规与 DuckDB 漏斗。" },
  { page: "security-department", name: "安全部门", icon: "shield", description: "查看项目安全评审，跟进整改与复审。" },
  { page: "operations-department", name: "运维部门", icon: "pulse", description: "检查服务状态，追踪版本更新与验证结果。" },
  { page: "resource-department", name: "资源成本部门", icon: "wallet", description: "核对各套餐的可用额度、重置时间和订阅费用。" },
] as const;
export type DepartmentPage = typeof companyDepartments[number]["page"];

export type InboxFilter = "all" | "pending" | "handled";
export type StageFilter = ProductStageId | "unfiled" | "";

export function chatRoomLink({ room, project, idea, draft }: {
  room?: string; project?: string; idea?: string; draft?: string;
} = {}) {
  const query = new URLSearchParams();
  if (room) query.set("room", room);
  if (project) query.set("project", project);
  if (idea) query.set("idea", idea);
  if (draft) query.set("draft", draft);
  return "#home-room" + (query.size ? "?" + query : "");
}

export function stageLink(step?: ProductStageId | "unfiled" | "", folder?: string) {
  if (!step || step === "unfiled") return folder ? "#projects?" + new URLSearchParams({ product: folder.split("/")[0] }) : "#product";
  const query = new URLSearchParams({ step });
  if (folder) {
    const [product, ...rest] = folder.split("/");
    if (product) query.set("product", product);
    if (rest.length) query.set("project", rest.join("/"));
  }
  return "#stage?" + query;
}

export function decisionTarget(item: ZoomMessage): string {
  if (item.origin === "workflow") return "#workflows/" + encodeURIComponent(item.taskId);
  if (item.businessTrial) {
    return "#business-lines?" + new URLSearchParams({ line: item.businessTrial.lineId, trial: item.businessTrial.trialId });
  }
  if (item.capabilityRequest) {
    return "#capabilities?" + new URLSearchParams({ request: item.capabilityRequest.id });
  }
  if (item.roomBinding) return "#home-room?" + new URLSearchParams({ binding: item.roomBinding });
  if (item.repository) return "#activity-index?" + new URLSearchParams({ view: "repos", repo: item.repository.fullName });
  if (item.stage) return stageLink(item.stage, item.folder);
  if (item.origin === "channel") return "#channels";
  return chatRoomLink({ project: item.folder || undefined });
}

export function inboxLink({ filter = "all", folder, stage, message }: {
  filter?: InboxFilter; folder?: string; stage?: StageFilter; message?: string;
} = {}) {
  if (stage && stage !== "unfiled") return stageLink(stage, folder);
  if (folder) return chatRoomLink({ project: folder });
  if (message) return chatRoomLink();
  if (filter === "pending") return "#workflows";
  return "#home-room";
}

export function inboxScope(hash: string) {
  const query = new URLSearchParams(hash.split("?")[1]);
  const value = query.get("filter");
  const filter: InboxFilter = value === "pending" || value === "handled" ? value : "all";
  const input = query.get("stage");
  const stage: StageFilter = input === "unfiled" ? input : productStages.find(item => item.id === input)?.id ?? "";
  return { filter, folder: query.get("folder") ?? "", stage, message: query.get("message") ?? "" };
}
