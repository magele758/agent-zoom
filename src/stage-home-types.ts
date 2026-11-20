export type StageHomeBot = { id: string; name: string };

export type StageHomeReceipt = {
  botId: string;
  botName: string;
  remoteId?: string;
  status: string;
  detail: string;
  checkedAt: string;
  evidence: string[];
  canRetry?: boolean;
};
