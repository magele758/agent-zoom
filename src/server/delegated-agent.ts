import type { Context, Hono } from "hono";
import { ApiError, type Principal, type Store } from "./logic.ts";
import { StageWorkStore } from "./stage-work.ts";

type Agent = Extract<Principal, { type: "agent" }>;

// Authenticate each recipient against the persisted delivery, including after a reconnect.
export class AgentDelegations {
  private work: StageWorkStore;
  constructor(private store: Store) {
    this.work = new StageWorkStore(store.db);
  }

  private available(agent: Agent) {
    if (agent.paused) throw new ApiError(403, "paused", "这个 agent 已暂停。");
  }

  private assigned(agent: Agent, id: string) {
    this.available(agent);
    if (
      !this.store.db
        .prepare(
          "SELECT 1 FROM inbox WHERE event_type='stage_offer' AND ref_id=? AND recipient_type='agent' AND recipient_id=?",
        )
        .get(id, agent.id)
    )
      throw new ApiError(404, "stage_offer", "没有分配给这个 agent 的委派。");
  }

  read(agent: Agent, id?: string) {
    this.available(agent);
    if (id) {
      this.assigned(agent, id);
      return this.work.detail(id);
    }
    const rows = this.store.db
      .prepare(
        "SELECT ref_id FROM inbox WHERE recipient_type='agent' AND recipient_id=? AND event_type='stage_offer' ORDER BY id DESC",
      )
      .all(agent.id);
    return { items: rows.map((row) => this.work.get(String(row.ref_id))).filter((w) => w.status !== "completed") };
  }

  claim(agent: Agent, id: string, session: unknown) {
    this.assigned(agent, id);
    return this.work.claim(id, { agent: agent.handle, session, via: "coding-agent" });
  }

  report(agent: Agent, id: string, event: unknown) {
    this.assigned(agent, id);
    return this.work.report(id, event);
  }

  renew(agent: Agent, id: string, claimId: unknown) {
    this.assigned(agent, id);
    return this.work.renew(id, { claimId });
  }
}

export function agentDelegationRoutes(app: Hono, store: Store, user: (c: Context) => Agent) {
  const service = new AgentDelegations(store);
  const base = "/api/agent/delegations";
  app.get(base, (c) => c.json(service.read(user(c))));
  app.get(base + "/:id", (c) => c.json(service.read(user(c), c.req.param("id")!)));
  app.post(base + "/:id/claim", async (c) =>
    c.json(service.claim(user(c), c.req.param("id")!, (await c.req.json()).session)),
  );
  app.post(base + "/:id/report", async (c) =>
    c.json(service.report(user(c), c.req.param("id")!, await c.req.json())),
  );
  app.post(base + "/:id/renew", async (c) =>
    c.json(service.renew(user(c), c.req.param("id")!, (await c.req.json()).claimId)),
  );
  return service;
}
