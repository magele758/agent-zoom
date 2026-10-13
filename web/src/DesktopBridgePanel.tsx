import {useEffect,useState} from 'react';
type Bridge={agentId:string;handle:string;threadId:string;enabled:boolean;paused:boolean;lastPollAt:string|null;lastReplyAt:string|null;replies:number};
export function DesktopBridgePanel({roomId}:{roomId:string}){
 const [bridges,setBridges]=useState<Bridge[]>([]),[error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 useEffect(()=>{
  let active=true;
  const refresh=async()=>{try{const r=await fetch(`/api/rooms/${roomId}/desktop-bridges`);if(!r.ok)throw new Error('无法读取桌面桥接状态');const data=await r.json();if(active){setBridges(data.bridges);setError('');}}catch(e){if(active)setError((e as Error).message);}};
  void refresh();const timer=setInterval(refresh,10000);
  return()=>{active=false;clearInterval(timer);};
 },[roomId]);
 async function toggle(bridge:Bridge){
  setBusy(true);try{const r=await fetch(`/api/rooms/${roomId}/desktop-bridges/${bridge.agentId}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:!bridge.enabled})});if(!r.ok)throw new Error('无法修改桌面桥接');setBridges(rows=>rows.map(row=>row.agentId===bridge.agentId?{...row,enabled:!row.enabled}:row));setError('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="desktop-bridge-panel" aria-label="本地桌面通信">
  <h3>本地桌面通信</h3>
  <p className="fine">当前桌面会话定时检查新聊天和提问。需要电脑开机、应用和频道服务运行；不是即时推送，也不会自动认领任务。</p>
  {error?<p role="alert">{error}</p>:null}
  {bridges.length===0?<p className="fine">这个频道尚未绑定本地桌面会话。</p>:bridges.map(bridge=>{
   const recent=bridge.lastPollAt&&Date.now()-Date.parse(bridge.lastPollAt)<180000;
   const status=!bridge.enabled?'桥接已暂停':bridge.paused?'客户端已停用':recent?'最近检查过收件箱':'等待桌面会话检查';
   return <div key={bridge.agentId} data-testid="desktop-bridge-status"><strong>@{bridge.handle} · {status}</strong>
    <p className="fine">最近检查：{bridge.lastPollAt?new Date(bridge.lastPollAt).toLocaleString():'尚无'}<br/>实际写回：{bridge.replies} 条 · 最近回复：{bridge.lastReplyAt?new Date(bridge.lastReplyAt).toLocaleString():'尚无'}</p>
    <details><summary>绑定会话</summary><code>{bridge.threadId}</code></details>
    <button type="button" disabled={busy} onClick={()=>void toggle(bridge)}>{bridge.enabled?'暂停桌面通信':'恢复桌面通信'}</button>
   </div>;
  })}
 </section>;
}
