import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../logic.ts";
import { parse } from "./contract.ts";

const markSchema = z.strictObject({
  action: z.enum(["read", "archive", "unarchive"]),
  through: z.int().nonnegative(),
});

export function addWorkflowBoardRoutes(app: Hono, db: DatabaseSync, requireBrowser: (c: Context) => string) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_workflow_marks (
    run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
    seen_through INTEGER NOT NULL DEFAULT 0,
    archived_through INTEGER
  )`);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_board_marks'").get()) {
    // Preserve the old per-person rows. A disagreement on archiving leaves the run visible.
    db.exec(`INSERT OR IGNORE INTO local_workflow_marks(run_id,seen_through,archived_through)
      SELECT run_id,MAX(seen_through),
        CASE WHEN COUNT(*)=COUNT(archived_through) THEN MIN(archived_through) END
      FROM workflow_board_marks GROUP BY run_id`);
  }
  const fields = "run_id AS id, seen_through AS seenThrough, archived_through AS archivedThrough";
  app.get("/api/workflows/board/marks", c => {
    requireBrowser(c);
    c.header("Cache-Control", "no-store");
    return c.json({ marks: db.prepare(`SELECT ${fields} FROM local_workflow_marks`).all() });
  });
  app.post("/api/workflows/:id/mark", async c => {
    requireBrowser(c);
    const id = c.req.param("id");
    const { action, through } = parse(markSchema, await c.req.json());
    const run = db.prepare("SELECT json_array_length(snapshot,'$.events') AS events FROM workflow_runs WHERE id=?").get(id);
    if (!run) throw new ApiError(404, "workflow_missing", "找不到这条运行");
    if (through > Number(run.events)) throw new ApiError(409, "workflow_mark", "请刷新任务记录后重试");
    if (action === "read") {
      db.prepare(`INSERT INTO local_workflow_marks(run_id,seen_through) VALUES (?,?)
        ON CONFLICT(run_id) DO UPDATE SET seen_through=max(seen_through,excluded.seen_through)`).run(id,through);
    } else {
      db.prepare(`INSERT INTO local_workflow_marks(run_id,archived_through) VALUES (?,?)
        ON CONFLICT(run_id) DO UPDATE SET archived_through=excluded.archived_through`).run(id,action === "archive" ? through : null);
    }
    return c.json(db.prepare(`SELECT ${fields} FROM local_workflow_marks WHERE run_id=?`).get(id));
  });
}
