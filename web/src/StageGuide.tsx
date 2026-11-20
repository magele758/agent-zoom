import { useId, useState, type ReactNode } from "react";
import type { ProductStageId } from "../../src/product-stages";
import { stageGuides, type StageAction, type StageDraft } from "../../src/stage-guides";
import "./stage-guide.css";

type Source = { label: string; reference: string };
type GuideProps = {
  stage: ProductStageId;
  product: string;
  sources?: Source[];
  initialInputs?: string;
  renderHandoff: (draft: StageDraft) => ReactNode;
};

const fields = [
  { key: "goal", label: "工作目标" },
  { key: "inputs", label: "依据与材料" },
  { key: "deliverable", label: "交付内容" },
  { key: "acceptance", label: "验收方法" },
] as const;

function initialDraft({ templateId, title, goal, inputs, deliverable, acceptance }: StageAction, extraInputs = ""): StageDraft {
  return { templateId, title, goal, inputs: [extraInputs.trim(), inputs].filter(Boolean).join("\n"), deliverable, acceptance };
}

export function StageGuide(props: GuideProps) {
  return <StageBrief key={JSON.stringify([props.product, props.stage, props.initialInputs ?? ""])} {...props} />;
}

function StageBrief({ stage, sources: available = [], initialInputs = "", renderHandoff }: GuideProps) {
  const definition = stageGuides[stage];
  const sources = Array.from(new Map(available.filter(item => item.reference.trim()).map(item => [item.reference, item])).values());
  const [current, setCurrent] = useState(definition.actions[0].templateId);
  const [edits, setEdits] = useState<Record<string, StageDraft>>({});
  const [editing, setEditing] = useState(false);
  const [reference, setReference] = useState("");
  const [sourceNotice, setSourceNotice] = useState("");
  const headingId = useId();
  const action = definition.actions.find(item => item.templateId === current)!;
  const draft = edits[current] ?? initialDraft(action, initialInputs);
  const source = sources.find(item => item.reference === reference) ?? sources[0];
  const attached = source && draft.inputs.split("\n").some(line => line === source.reference || line.endsWith(" " + source.reference));
  const missing = !draft.title.trim() ? "任务名称" : fields.find(field => !draft[field.key].trim())?.label;

  function change(key: Exclude<keyof StageDraft, "templateId">, value: string) {
    setEdits(previous => ({ ...previous, [current]: { ...(previous[current] ?? initialDraft(action, initialInputs)), [key]: value } }));
  }

  function attach() {
    if (!source || attached) return;
    const line = source.label === source.reference ? source.reference : source.label + " " + source.reference;
    change("inputs", [draft.inputs.trimEnd(), line].filter(Boolean).join("\n"));
    setSourceNotice("已附入依据与材料");
  }

  return <section className="sg-guide" aria-labelledby={headingId}>
    <h2 id={headingId}>发起阶段任务</h2>
    <div className="sg-actions" role="group" aria-label="选择要开展的工作">
      {definition.actions.map(item => <button type="button" key={item.templateId} aria-pressed={current === item.templateId}
        onClick={() => { setCurrent(item.templateId); setEditing(false); setSourceNotice(""); }}>{item.label}</button>)}
    </div>
    <div className="sg-brief">
      <header className="sg-brief-head"><h3>{draft.title || action.label}</h3>
        <button type="button" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {editing ? "收起编辑" : "编辑任务单"}</button>
      </header>
      {editing ? <div className="sg-editor">
        <label>任务名称<input value={draft.title} onChange={event => change("title", event.target.value)} /></label>
        {fields.map(field => <label key={field.key}>{field.label}
          <textarea rows={field.key === "inputs" ? 3 : 2} value={draft[field.key]} onChange={event => change(field.key, event.target.value)} />
        </label>)}
        <p>修改用于这份任务草稿。已发出的任务保留原任务单。</p>
      </div> : <dl className="sg-fields">{fields.map(field => <div key={field.key}>
        <dt>{field.label}</dt><dd>{draft[field.key] || "待填写"}</dd></div>)}</dl>}
      {sources.length > 0 && <div className="sg-sources">
        <label>可用资料
          <select aria-label="选择可附入任务的资料" value={source?.reference} onChange={event => {
            setReference(event.target.value); setSourceNotice("");
          }}>{sources.map(item => <option key={item.reference} value={item.reference}>{item.label}</option>)}</select>
        </label>
        <button type="button" disabled={attached} onClick={attach}>{attached ? "已附入" : "附入任务"}</button>
        <span className="sg-announcement" role="status">{sourceNotice}</span>
      </div>}
    </div>
    <div className="sg-handoff">
      {missing ? <p role="status">请在任务单中填写{missing}。</p> : renderHandoff(draft)}
    </div>
  </section>;
}
