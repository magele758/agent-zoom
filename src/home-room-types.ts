export type HomeRoomTarget = { id: string; title: string; botIds: string[] };
export type HomeRoomBinding = {
  id: string;
  localRoom: string;
  remoteRoom: string;
  project: string;
  roomTitle: string;
  botId: string;
  botName: string;
  problem: string | null;
};
export type HomeRoomPost = {
  id: string;
  binding: string;
  direction: "out" | "in";
  body: string;
  state: "sending" | "unknown" | "retryable" | "received";
  remoteId: string | null;
  turnId: string | null;
  parent: string | null;
  question: number;
  createdAt: string;
};
export type HomeRoomIdeaRef = {
  bindingId: string;
  postId: string;
  roomId?: string;
  project: string;
  roomTitle: string;
  botName: string;
  direction: "out" | "in";
  excerpt: string;
  createdAt: string;
};

export type HomeChatBot = {
  id: string;
  name: string;
  title?: string;
  description?: string;
  status?: "idle" | "running" | "paused" | "disabled";
  activeWorkCount?: number;
  pendingCount?: number;
  completedCount?: number;
  groupId?: string | null;
  groupName?: string | null;
};
export type HomeChatGroup = {
  id: string;
  name: string;
  botIds: string[];
  roomIds: string[];
};
export type HomeChatRoom = {
  id: string;
  title: string;
  status: string;
  botIds: string[];
  hostBotId?: string;
  replyMode?: string;
  updatedAt?: string;
};
export type HomeChatLink = {
  scopeKey: string;
  remoteRoom: string;
  roomTitle: string;
  updatedAt: string;
};
export type HomeChatMessage = {
  id: string;
  roomId: string;
  seq: number;
  turnId?: string;
  text: string;
  createdAt: string;
  sender: { type: "user" | "bot"; id: string; name: string };
  mentions?: string[];
  replyTo?: { messageId: string; botId?: string; excerpt?: string };
};
export type HomeChatTurn = {
  id: string;
  roomId: string;
  messageId: string;
  status?: string;
  botIds: string[];
  mentionedBotIds?: string[];
  replyMode?: string;
};
export type HomeChatOverview = {
  available: boolean;
  origin: string;
  apiOrigin?: string;
  webOrigin?: string;
  webAvailable?: boolean;
  reason?: string;
  rooms: HomeChatRoom[];
  bots: HomeChatBot[];
  groups?: HomeChatGroup[];
  links: HomeChatLink[];
};
export type HomeChatRoomDetail = {
  room: HomeChatRoom;
  messages: HomeChatMessage[];
  hasMore: boolean;
  nextCursor: number | null;
  bots: HomeChatBot[];
  turns: HomeChatTurn[];
};
