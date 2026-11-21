export type ExecutiveDepartmentId =
  | "commercial"
  | "rd"
  | "operations"
  | "security"
  | "resources";

export type ExecutiveDepartmentBlueprint = {
  id: ExecutiveDepartmentId;
  botName: string;
  botTitle: string;
  departmentName: string;
  summary: string;
  faceShape: string;
  faceColor: string;
  faceStyle: string;
  faceExpression: string;
  ownedPages: Array<{ label: string; href: string }>;
  autonomousScope: string[];
  approvalRedlines: string[];
  defaultPatrolPrompt: string;
};

export type ExecutiveBotRuntime = {
  botId: string | null;
  name: string;
  title: string;
  exists: boolean;
  status: "idle" | "running" | "paused" | "disabled" | "missing";
  activeWorkCount: number;
  pendingCount: number;
  completedCount: number;
  failedCount: number;
  inGroup: boolean;
  inRoom: boolean;
};

export type ExecutiveDepartmentView = ExecutiveDepartmentBlueprint & {
  runtime: ExecutiveBotRuntime;
  liveHighlights: string[];
};

export type ExecutiveTaskItem = {
  id: string;
  requesterBotId: string;
  requesterName: string;
  targetBotId: string;
  targetName: string;
  status: string;
  input: string;
  result: string;
  failureReason: string;
  updatedAt: string;
};

export type ExecutiveStatus = {
  agentHomeReachable: boolean;
  agentHomeOrigin: string;
  bootstrapped: boolean;
  group: { id: string; name: string } | null;
  room: { id: string; title: string; replyMode: string; linkedDefault: boolean } | null;
  delegationRoutedToSuperBot: boolean;
  briefCron: { id: string; name: string; schedule: string; enabled: boolean; nextRunAt: string | null } | null;
  superBot: ExecutiveBotRuntime;
  departments: ExecutiveDepartmentView[];
  recentTasks: ExecutiveTaskItem[];
  companyPulse: {
    pendingApprovals: number;
    onlineMachines: number;
    totalMachines: number;
    healthyServices: number;
    totalServices: number;
    pilotCompletionPct: number;
    pilotProduct: string;
    openSecurityReviews: number;
  };
  error?: string;
};
