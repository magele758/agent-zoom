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

export type CodingResourceNode = {
  id: string;
  name: string;
  kind: "bot_worker" | "coding_agent_cli";
  runtime: string;
  status: "idle" | "running" | "online" | "offline" | "paused";
  activeWorkCount: number;
  completedCount: number;
  groupName?: string;
};

export type CodingResourceRequest = {
  id: string;
  requesterDept: ExecutiveDepartmentId | "executive";
  requesterName: string;
  title: string;
  repo: string;
  objective: string;
  acceptance: string;
  priority: "high" | "normal" | "low";
  taskId: string | null;
  status: "queued" | "running" | "completed" | "failed";
  report: string;
  createdAt: string;
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
  codingResourcePool: {
    managedByDeptId: "rd";
    managedByBotId: string | null;
    managedByBotName: string;
    groupName: string | null;
    nodes: CodingResourceNode[];
  };
  codingRequests: CodingResourceRequest[];
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

export type ExecutiveReceiptTrace = {
  request: string;
  background: string;
  purpose: string;
  result: string;
  evidence: string[];
  deliveryUnavailable?: boolean;
  status: string;
  failureReason?: string;
  createdAt?: string;
  requestedAt?: string;
  returnedAt?: string;
  origin?: {
    kind: "zoom" | "workflow" | "delegation" | "room";
    title: string;
    href: string;
    taskId?: string;
    messageId?: string;
    workId?: string;
    delegationId?: string;
    project?: string;
    patrolRunId?: string;
  };
  affectedTasks: {
    id: string; title: string; project: string; status: string; observedStatus: string; latestRunId: string | null;
    latestRun?: { status: string; errorSummary: string; completedAt: string | null };
  }[];
  decisionId?: string;
  decision?: {
    kind: "kernel" | "zoom" | "workflow"; id: string; status: string; actionable: boolean; href: string;
    options: { id: string; label: string }[];
  };
};

export type ExecutiveMailItem = {
  id: string;
  source: "executive_room" | "department_task";
  direction: "inbound" | "outbound";
  senderId: string;
  senderName: string;
  senderRole: string;
  subject: string;
  excerpt: string;
  body: string;
  status: "working" | "completed" | "failed" | "cancelled" | "sent";
  read: boolean;
  needsDecision: boolean;
  createdAt: string;
  /** This linked terminal record was retained locally after leaving Agent Home's recent list. */
  historical?: true;
  roomId?: string;
  messageId?: string;
  taskId?: string;
  departmentId?: ExecutiveDepartmentId;
  trace?: ExecutiveReceiptTrace;
};

export type ExecutiveMailboxResponse = {
  agentHomeReachable: boolean;
  agentHomeOrigin: string;
  bootstrapped: boolean;
  roomId: string | null;
  roomTitle: string | null;
  superBotId: string | null;
  superBotWorking: boolean;
  items: ExecutiveMailItem[];
  /** Locally verified original patrol notifications, independent of Bot receipts. */
  sourceTraces?: Record<string, ExecutiveReceiptTrace>;
  error?: string;
};
