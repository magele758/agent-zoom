import type { Delegation } from "./delegation-types.ts";
import type { ProductStageId } from "./product-stages.ts";
import type { RepositorySnapshot } from "./project-types.ts";

export type ZoomAction =
  | { kind: "reply" }
  | { kind: "decision"; cardId: string; revision: number }
  | { kind: "retry" | "recover"; attemptId: string; revision: number }
  | { kind: "channel-reply"; roomId: string; messageId: string; taskId?: string };

export type ZoomMessage = {
  id: string;
  origin: "external" | "workflow" | "channel" | "repository";
  kind: "task" | "progress" | "question" | "decision" | "completed" | "reply" | "recovery";
  taskId: string;
  taskTitle: string;
  context?: string;
  source: string;
  folder: string;
  stage?: ProductStageId;
  repository?: RepositorySnapshot;
  body: string;
  at: string;
  pending: boolean;
  requiresApproval?: boolean;
  delegation?: Delegation;
  roomBinding?: string;
  capabilityRequest?: {id:string; revision?:number};
  businessTrial?: {lineId:string; trialId:string};
  readOnly?: boolean;
  revision?: number;
  attemptId?: string;
  action?: ZoomAction;
  choices?: string[];
  choice?: string;
  actor?: string;
  evidence?: string[];
  replyTo?: string;
};

export type ZoomTask = {
  id: string;
  externalId: string;
  source: string;
  title: string;
  folder: string;
  stage?: ProductStageId;
  context: string;
};

export type ZoomFeedbackEvent = {
  seq: number;
  questionId: string;
  questionEventId: string;
  evidence?: string[];
  question: string;
  body: string;
  choice?: string;
  actor: string;
  at: string;
};
