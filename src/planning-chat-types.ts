export type PlanningChatProposal = {
  project: string;
  title: string;
  description: string;
  agentId: string | null;
};

export type PlanningChatTurn = {
  id: string;
  text: string;
  reply: string;
  status: "pending" | "answered" | "failed";
  proposal: PlanningChatProposal | null;
  botName: string;
  taskId: string | null;
  runId: string | null;
  error: string;
};

export type PlanningChatView = { project: string; turns: PlanningChatTurn[] };
