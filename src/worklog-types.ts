export type HubState = "doing" | "done" | "stuck" | "todo";
export type HubItem = { key: string; title: string; mainline: string; projectHint: string; state: HubState };
export type HubDay = { date: string; records: HubItem[] };
export type WorklogTarget = { product: string; project: string; lineId: string | null };
export type WorklogBinding = WorklogTarget & { date: string; key: string; title: string; mainline: string };
export type WorklogIndex = {
  hubOrigin: string;
  bindings: WorklogBinding[];
  projects: Array<{ product: string; project: string }>;
  lines: Array<{ id: string; name: string }>;
};
