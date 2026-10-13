import { useEffect, useState } from "react";
import { api, type CoordinationRun } from "./api";
const phases:Record<string,string>={running:"正在分析",ready:"待确认派发",blocked:"无法安排",failed:"协调失败",canceled:"已停止",stale:"方案已过期",applied:"已派发"};
const roles:Record<string,string>={research:"课题研究",product:"产品",ui:"设计",tech:"架构",build:"实现",review:"评审",qa:"测试"};
export function CoordinatorPanel({roomId,onChanged,onError}:{roomId:string;onChanged:()=>void;onError:(text:string)=>void}) {
  const [info,setInfo]=useState<{configured:boolean;model:string;source:string;error:string}|null>(null);
  const [prompt,setPrompt]=useState(()=>localStorage.getItem(`coordinator-draft:${roomId}`)||"");
  const [run,setRun]=useState<CoordinationRun|null>(null);const [busy,setBusy]=useState(false);const [loadError,setLoadError]=useState("");
  useEffect(()=>{let alive=true;void Promise.all([api.coordinatorInfo(),api.coordination(roomId)]).then(([info,result])=>{if(alive){setInfo(info);setRun(result.runs[0]??null);}}).catch(error=>{if(alive)setLoadError(error.message)});return()=>{alive=false}},[roomId]);
  useEffect(()=>{if(run?.status!=="running")return;let alive=true;const id=run.id;const timer=setTimeout(()=>void api.coordinationRun(id).then(next=>{if(alive)setRun(current=>current?.id===id?next:current)}).catch(error=>{if(alive)setLoadError(error.message)}),1000);return()=>{alive=false;clearTimeout(timer)}},[run]);
  const action=async(operation:()=>Promise<void>)=>{setBusy(true);setLoadError("");try{await operation()}catch(error){onError(error instanceof Error?error.message:String(error));if(run)void api.coordinationRun(run.id).then(setRun).catch(()=>{});}finally{setBusy(false)}};
  return <details className="coordinator-panel" data-testid="coordinator-panel">
    <summary>辅助协调 Agent <span>{run?phases[run.status]:"分析分工与调度"}</span></summary>
    <p className="fine">读取当前频道，先给出分工建议。确认后派发给真实客户端，执行和验收仍由它们完成。</p>
    {info?.configured?<p className="fine">协调模型：{info.model} · {info.source}</p>:<p role="status" className="fine">{info?.error||loadError||"正在读取模型配置…"}</p>}
    <label className="coordinator-label" htmlFor={`coordinate-${roomId}`}>要协调的需求</label>
    <textarea id={`coordinate-${roomId}`} data-testid="coordinator-prompt" rows={3} value={prompt} maxLength={4000} onChange={event=>{setPrompt(event.target.value);localStorage.setItem(`coordinator-draft:${roomId}`,event.target.value)}} placeholder="例如：根据当前成员的身份，安排实现、评审和测试；指出缺少或不可用的客户端。"/>
    <div className="coordinator-actions"><button type="button" data-testid="coordinator-generate" disabled={!info?.configured||!prompt.trim()||busy||run?.status==="running"} onClick={()=>void action(async()=>{setRun(await api.coordinate(roomId,prompt))})}>分析并生成方案</button>
      {run?.status==="running"?<button type="button" data-testid="coordinator-stop" disabled={busy} onClick={()=>void action(async()=>setRun(await api.stopCoordination(run.id)))}>停止协调</button>:null}</div>
    {run?<article className="coordinator-result" data-testid="coordinator-result" aria-live="polite">
      <strong>协调身份 · {phases[run.status]}</strong>
      <p className="fine">模型：{run.model}</p>
      {run.error?<p className="note">{run.error}</p>:null}
      {run.plan?<><p>{run.plan.summary}</p>
        {run.plan.mode==="task"?<p>实现 → @{run.plan.handle}</p>:run.plan.steps?<ol>{run.plan.steps.map(step=><li key={step.role}>{roles[step.role]||step.role} → @{step.handle}</li>)}</ol>:null}
        {run.plan.warnings.length?<ul className="coordinator-warnings">{run.plan.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>:null}
        {run.plan.mode!=="blocked"?<details><summary>查看实际派发内容与验收</summary><p className="coordinator-body">{run.plan.body}</p><p>验收：{run.plan.acceptance}</p></details>:null}
        {run.status==="ready"?<button type="button" className="local-add" data-testid="coordinator-apply" disabled={busy} onClick={()=>void action(async()=>{const result=await api.applyCoordination(run.id);setRun(result.run);onChanged()})}>确认并派发</button>:null}
      </>:null}
      {run.taskId?<p>已创建任务 <code>{run.taskId.slice(0,8)}</code>。<button type="button" className="text-button" onClick={()=>window.dispatchEvent(new CustomEvent("show-task",{detail:run.taskId}))}>查看任务与结果</button></p>:null}
      {run.trace.length?<details><summary>查看 SDK 执行记录</summary><ul>{run.trace.filter(item=>item.tool).map((item,index)=><li key={index}>{item.kind} · {item.tool}</li>)}</ul></details>:null}
    </article>:null}
  </details>;
}
