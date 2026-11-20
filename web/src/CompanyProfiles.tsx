import { useEffect, useState, type FormEvent } from "react";
import type { ProjectProfile as Profile, ReusedResult } from "../../src/project-profile-types";
import type { WorklogBinding, WorklogIndex } from "../../src/worklog-types";
import { request } from "./api";

const path = "/api/opc/projects/profiles";
export function ProjectProfile({
  product,
  project,
  onSaved,
}: {
  product: string;
  project: string;
  onSaved?: () => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [worklogs, setWorklogs] = useState<{ hubOrigin: string; items: WorklogBinding[] }>({
    hubOrigin: "http://127.0.0.1:28790",
    items: [],
  });
  const [draft, setDraft] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request<{ profiles: Profile[] }>(path, { signal: controller.signal })
      .then((result) => {
        setProfiles(result.profiles);
        setDraft(result.profiles.find((x) => x.product === product && x.project === project) ?? null);
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    request<WorklogIndex>("/api/opc/worklog", { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setWorklogs({
          hubOrigin: result.hubOrigin || "http://127.0.0.1:28790",
          items: result.bindings.filter((b) => b.product === product && b.project === project),
        });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [product, project, version]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setDraft(await request<Profile>(path, { method: "PUT", body: JSON.stringify(draft) }));
      setNotice("已保存项目档案");
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const consumers = profiles.flatMap((p) =>
    p.uses.filter((u) => u.product === product && u.project === project).map((use) => ({ ...p, use })),
  );
  const others = profiles.filter((p) => p.product !== product || p.project !== project);
  function changeUse(index: number, patch: Partial<ReusedResult>) {
    if (draft)
      setDraft({ ...draft, uses: draft.uses.map((use, i) => (i === index ? { ...use, ...patch } : use)) });
  }
  return (
    <div className="project-profile">
      {consumers.length > 0 && (
        <section>
          <b>哪些项目用了这里的成果</b>
          <ul>
            {consumers.map((p, index) => (
              <li key={index}>
                <a href={"#projects?" + new URLSearchParams({ product: p.product, project: p.project })}>
                  {p.product} / {p.project}
                </a>
                {" · " + p.use.reference + " · " + p.use.purpose}
              </li>
            ))}
          </ul>
        </section>
      )}
      {worklogs.items.length > 0 && (
        <section aria-label="已关联的工作投入">
          <b>已关联的工作投入</b>
          <ul>
            {worklogs.items.map((item) => (
              <li key={item.date + item.key}>
                <a href={"#worklog?" + new URLSearchParams({ date: item.date, item: item.key })}>{item.date}</a>
                {" · " + item.title + " · " + item.mainline + " "}
                <a href={worklogs.hubOrigin + "/#d=" + encodeURIComponent(item.date)} target="_blank" rel="noreferrer">
                  Agent Hub ↗
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setVersion((v) => v + 1)}>
            重新读取
          </button>
        </p>
      )}
      {draft && (
        <form onSubmit={save}>
          <fieldset disabled={busy}>
            <label>
              项目层级
              <input
                maxLength={100}
                value={draft.layer}
                onChange={(e) => setDraft({ ...draft, layer: e.target.value })}
                placeholder="例如，基础能力"
              />
            </label>
            <label>
              业务领域
              <input
                maxLength={100}
                value={draft.domain}
                onChange={(e) => setDraft({ ...draft, domain: e.target.value })}
                placeholder="例如，店铺运营"
              />
            </label>
            {draft.uses.map((use, index) => (
              <div className="project-reuse" key={index}>
                <label>
                  成果来源
                  <select
                    value={JSON.stringify([use.product, use.project])}
                    onChange={(e) => {
                      const [otherProduct, otherProject] = JSON.parse(e.target.value);
                      changeUse(index, { product: otherProduct, project: otherProject });
                    }}
                  >
                    {others.map((p) => (
                      <option
                        key={JSON.stringify([p.product, p.project])}
                        value={JSON.stringify([p.product, p.project])}
                      >
                        {p.product} / {p.project}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  版本或证据
                  <input
                    required
                    maxLength={1200}
                    value={use.reference}
                    onChange={(e) => changeUse(index, { reference: e.target.value })}
                  />
                </label>
                <label>
                  复用在什么地方
                  <input
                    required
                    maxLength={1000}
                    value={use.purpose}
                    onChange={(e) => changeUse(index, { purpose: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, uses: draft.uses.filter((_, i) => i !== index) })}
                >
                  取消此引用
                </button>
              </div>
            ))}
            {others.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    uses: [
                      ...draft.uses,
                      { product: others[0].product, project: others[0].project, reference: "", purpose: "" },
                    ],
                  })
                }
              >
                引用另一项目的成果
              </button>
            )}
            <button>保存档案</button>
            {notice && <span role="status">{notice}</span>}
          </fieldset>
        </form>
      )}
    </div>
  );
}
