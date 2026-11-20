export type LearnDocument = { id: string; title: string; kind: "web" | "pdf" | "clip"; url: string };
export type LearnSession = { id: string; title: string; url: string; completed: boolean; updatedAt: string };
export type LearnConnection = {
  available: boolean;
  canClip: boolean;
  homeUrl?: string;
  documents: LearnDocument[];
  sessions: LearnSession[];
  reason?: string;
};
export type LearnClipReceipt = { id: string; url: string; reviewUrl?: string; duplicate: boolean };
