import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const credentials=JSON.parse(readFileSync(option('--credentials')??process.env.AGENT_CHATROOM_CREDENTIALS??'data/credentials.json','utf8'));
const handle=option('--handle')??'chatgpt';
const saved=credentials.agents[handle];
if(!saved?.token) throw new Error('没有该客户端的凭证');
const base=credentials.url.replace(/\/$/,'');
async function call(path,body){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${saved.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.message??`HTTP ${response.status}`);
  return data;
}
try {
  const command=args[0]??'poll';
  let result;
  if(command==='bind'||command==='pause'){
    const current=await call('/api/agent/desktop-inbox');
    const roomId=option('--room')??current.bridge?.room_id??saved.roomId;
    const threadId=option('--thread')??current.bridge?.thread_id;
    if(!roomId||!threadId) throw new Error('bind 需要 --room 和 --thread');
    result=await call('/api/agent/desktop-bridge',{roomId,threadId,enabled:command==='bind'});
  }else if(command==='reply'){
    if(!option('--file')) throw new Error('reply 需要 --file，内容为 eventId/roomId/group/body JSON');
    if(!option('--thread')) throw new Error('reply 需要 --thread，避免回复到另一段会话的订阅');
    result=await call('/api/agent/desktop-replies',{...JSON.parse(readFileSync(option('--file'),'utf8')),threadId:option('--thread')});
  }else if(command==='poll'){
    result=await call('/api/agent/desktop-inbox');
  }else throw new Error('命令: bind | poll | reply | pause');
  if(option('--thread')&&result.bridge&&result.bridge.thread_id!==option('--thread')) throw new Error('绑定的是另一段桌面会话');
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
