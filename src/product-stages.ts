export const productStages = [
  { id: "research", label: "信息收集" },
  { id: "idea", label: "Idea" },
  { id: "prd", label: "PRD" },
  { id: "design", label: "设计稿" },
  { id: "development", label: "开发组" },
  { id: "testing", label: "测试组" },
  { id: "release", label: "发布" },
  { id: "operations", label: "运维" },
  { id: "trace", label: "Trace" },
  { id: "gtm", label: "GTM" },
  { id: "acquisition", label: "营销推广、获客" },
  { id: "revenue", label: "营收" },
  { id: "accounting", label: "记账" },
] as const;

export type ProductStageId = (typeof productStages)[number]["id"];
export const productStageIds = productStages.map(stage => stage.id);
