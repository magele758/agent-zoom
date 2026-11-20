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
  project: string;
  roomTitle: string;
  botName: string;
  direction: "out" | "in";
  excerpt: string;
  createdAt: string;
};
