import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
if(process.platform!=='darwin') throw new Error('本脚本仅配置当前 Mac 的 launchd 服务');
const domain=`gui/${process.getuid()}`;
const folder=join(homedir(),'Library','LaunchAgents');
const logs=join(root,'data','service-logs');
mkdirSync(folder,{recursive:true});mkdirSync(logs,{recursive:true});
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const jobs=[{name:'server',args:['node_modules/tsx/dist/cli.mjs','src/server/index.ts']},{name:'web',args:['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','5173','--strictPort']}];
for(const job of jobs){
 const label=`local.ppeng.agent-chatroom.${job.name}`;
 const path=join(folder,label+'.plist');
 if(process.argv.includes('--stop')){
  try{execFileSync('launchctl',['bootout',`${domain}/${label}`],{stdio:'pipe'});}catch{}
  execFileSync('launchctl',['disable',`${domain}/${label}`]);console.log(`已停用 ${label}`);continue;
 }
 if(existsSync(path)&&!readFileSync(path,'utf8').includes(xml(root))) throw new Error(`已有其他项目的配置，拒绝覆盖 ${path}`);
 const args=[process.execPath,...job.args.map((arg,i)=>i===0?join(root,arg):arg)];
 const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg=>`<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(dirname(process.execPath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>PORT</key><string>8791</string></dict>
<key>StandardOutPath</key><string>${xml(join(logs,job.name+'.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logs,job.name+'.error.log'))}</string></dict></plist>`;
 try{execFileSync('launchctl',['bootout',`${domain}/${label}`],{stdio:'pipe'});}catch{}
 writeFileSync(path,plist,{mode:0o600});execFileSync('launchctl',['enable',`${domain}/${label}`]);execFileSync('launchctl',['bootstrap',domain,path]);
 console.log(`已启动 ${label}（登录启动、退出后重启），日志 data/service-logs/${job.name}.log`);
}
