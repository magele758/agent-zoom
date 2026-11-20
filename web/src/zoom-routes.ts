import { productStages, type ProductStageId } from "../../src/product-stages";

export const companyDepartments = [
  { page: "commercial", name: "商业与治理部", icon: "growth", description: "统筹 7 层资产地图、1 号变现试点、收银离线授权、门面合规与 DuckDB 漏斗。" },
  { page: "security-department", name: "安全部门", icon: "shield", description: "查看项目安全评审，跟进整改与复审。" },
  { page: "operations-department", name: "运维部门", icon: "pulse", description: "检查服务状态，追踪版本更新与验证结果。" },
  { page: "resource-department", name: "资源成本部门", icon: "wallet", description: "核对各套餐的可用额度、重置时间和订阅费用。" },
] as const;
export type DepartmentPage = typeof companyDepartments[number]["page"];

export type InboxFilter = "all" | "pending" | "handled";
export type StageFilter = ProductStageId | "unfiled" | "";
export function inboxLink({ filter = "all", folder, stage, message }: {
  filter?: InboxFilter; folder?: string; stage?: StageFilter; message?: string;
} = {}) {
  const query = new URLSearchParams();
  if (filter !== "all") query.set("filter", filter);
  if (folder) query.set("folder", folder);
  if (stage) query.set("stage", stage);
  if (message) query.set("message", message);
  return "#inbox" + (query.size ? "?" + query : "");
}

export function inboxScope(hash: string) {
  const query = new URLSearchParams(hash.split("?")[1]);
  const value = query.get("filter");
  const filter: InboxFilter = value === "pending" || value === "handled" ? value : "all";
  const input = query.get("stage");
  const stage: StageFilter = input === "unfiled" ? input : productStages.find(item => item.id === input)?.id ?? "";
  return { filter, folder: query.get("folder") ?? "", stage, message: query.get("message") ?? "" };
}
