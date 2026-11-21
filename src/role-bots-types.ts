export type RoleBotId = "pm" | "research" | "design" | "qa";

export type RoleBotResolution = "reused" | "created" | "on_demand";

export type RoleBotBlueprint = {
  id: RoleBotId;
  roleName: string;
  botName: string;
  botTitle: string;
  engineRule: string;
  coordinationScope: string[];
  matchHints: string[];
  faceShape: "pebble" | "capsule" | "cloud" | "drop" | "bean";
  faceColor: "coral" | "mint" | "sky" | "lilac" | "butter";
  faceStyle: "soft" | "classic" | "crisp";
  faceExpression: "happy" | "curious" | "content" | "neutral" | "wink";
};

export type RoleBotView = RoleBotBlueprint & {
  resolution: RoleBotResolution;
  botId: string | null;
  resolvedName: string | null;
  matchedBy: string | null;
  status: "idle" | "running" | "paused" | "disabled" | "on_demand";
  inGroup: boolean;
  inRoom: boolean;
  updatedAt: string | null;
};

export type RoleBotIndex = {
  agentHomeReachable: boolean;
  agentHomeOrigin: string;
  principle: string;
  roles: RoleBotView[];
  error?: string;
};

export type RoleBotEnsureResult = {
  roleId: RoleBotId;
  action: "reused" | "created";
  botId: string;
  botName: string;
  matchedBy: string;
  inGroup: boolean;
  inRoom: boolean;
};

export type RoleBotCoordinateResult = RoleBotEnsureResult & {
  taskId: string;
  roomPosted: boolean;
  roomId: string | null;
};
