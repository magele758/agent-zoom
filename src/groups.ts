export const GROUPS = [
  {
    id: "research",
    label: "课题研究",
    phase: "design",
    capability: "先把问题、约束和未知查清楚，写出研究结论。不改代码。",
  },
  {
    id: "product",
    label: "产品设计师",
    phase: "design",
    capability: "先定用户、范围和验收，写出产品方案。不改代码。",
  },
  {
    id: "design",
    label: "设计师",
    phase: "design",
    capability: "先定界面、流程和关键画面，写出设计说明。不改代码。",
  },
  {
    id: "architect",
    label: "技术架构师",
    phase: "design",
    capability: "先定结构、边界和接口，写出技术方案。不改代码。",
  },
  {
    id: "build",
    label: "实现",
    phase: "build",
    capability: "按已有方案改代码，并交出可运行的结果。",
  },
  {
    id: "review",
    label: "评审",
    phase: "check",
    capability: "对照验收看实现，指出要改的地方。",
  },
  {
    id: "test",
    label: "测试",
    phase: "check",
    capability: "按验收验证结果，给出通过或失败。",
  },
] as const;

export type GroupId = (typeof GROUPS)[number]["id"];

export function splitTags(value: string | null | undefined) {
  return [...new Set(String(value ?? "").toLowerCase().split(/[\s,，]+/).filter(Boolean))].slice(0, 8);
}

export function groupById(id: string | null | undefined) {
  const key = String(id ?? "").trim().toLowerCase();
  return GROUPS.find((group) => group.id === key) ?? null;
}

export function groupOf(tags: string | null | undefined) {
  const have = splitTags(tags);
  return GROUPS.find((group) => have.includes(group.id)) ?? null;
}

export function groupLabel(tags: string | null | undefined) {
  return groupOf(tags)?.label ?? "";
}

export function normalizeGroup(value: unknown, fallback = "build") {
  if (value == null || String(value).trim() === "") return fallback;
  return groupById(String(value))?.id ?? null;
}
