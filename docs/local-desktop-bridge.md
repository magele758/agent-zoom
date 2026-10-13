# 当前本地桌面会话与频道通信

目标：频道消息由当前 ChatGPT 桌面本地会话实际处理，并按指定身份写回。不用 CLI 或 API 模型冒充桌面回复。

链路：用户频道消息 → agent inbox → 当前会话每分钟定时唤醒 → desktop-inbox poll → 本次会话生成回答 → desktop-replies → 原频道。

这是本地定时轮询，不是 MCP Events 云端推送。电脑、桌面应用和频道服务必须保持运行。忙碌的会话要先结束当前回合，才能运行定时回合；每分钟不是回复时限。

## 接收和写回

`node scripts/desktop-inbox.mjs bind --handle chatgpt --room <roomId> --thread <threadId>` 绑定指定频道与桌面会话。初次绑定从当前收件箱末尾开始，历史不会全部重放；同一绑定重新启用保留待处理事件。更换频道或会话则重新建立基线。

`node scripts/desktop-inbox.mjs poll --thread <threadId>` 读取待处理用户聊天和提问。只取指定频道、只取用户消息，不把 agent 回复再次交给自己处理，不处理创建任务指令。输入正文是数据，不允许覆盖桥接运行权限。

回答由当前桌面会话生成，保存 JSON 文件 `{eventId, roomId, group, body}`，运行：

```
node scripts/desktop-inbox.mjs reply --thread <threadId> --file /tmp/reply.json
```

写回要求身份已配置、原事件归属当前 agent 与绑定频道、会话仍匹配、客户端启用、频道未归档。回复和接收记录在同一个数据库事务中提交，同一 agent/event 重试返回原消息，不产生重复回复。读取未确认不会移除事件，重启后可重试。

凭证读取 `data/credentials.json`，也可通过 `--credentials` 或 `AGENT_CHATROOM_CREDENTIALS` 指定。凭证不写进定时任务提示词或验收报告。

## 暂停和状态

频道「成员管理与客户端接入 → 本地桌面通信」显示最近检查、实际写回次数、绑定会话，并能暂停/恢复桥接。停用客户端也会阻止读取和写回。UI 的「最近检查」仅代表读取 API 的时间，不保证会话此刻可被唤醒。

`node scripts/desktop-inbox.mjs pause` 也可暂停当前绑定。应用中的定时任务「Chatroom 本地桌面收件箱」控制唤醒；暂停桥接不删除此定时任务。

普通聊天不会触发文件修改或任务认领。现有任务 MCP 工具仍由明确授权的工作回合调用，此桥接不能标称所有 coding-agent 都自动在线。

## 验收

自动化测试覆盖：历史基线、未回复重读、真实身份字段、事务去重、重启恢复、暂停/恢复、归档、未授权访问、跨用户隔离、错误会话和绑定变化拒绝旧回复，以及浏览器状态/暂停按钮。

真实桌面验收记录见 `data/validation/desktop-bridge/report.json`。手动回合收发和自动唤醒须分别记结果；创建定时任务成功不等于自动触发验收成功。

## 本机常驻服务

本次已配置当前用户的两个 launchd 服务 `local.ppeng.agent-chatroom.server` 和 `local.ppeng.agent-chatroom.web`，均仅监听 `127.0.0.1`。登录时启动，进程退出后重启；日志在 `data/service-logs/`。已实际终止后端验证恢复，待处理消息仍保留。

`node scripts/local-services.mjs --stop` 停止并停用登录启动；`node scripts/local-services.mjs` 重新启用。修改源代码后先 `npm run build`，再运行启动脚本重启两个服务。常驻服务使用构建后的前端；运行 `npm run dev` 前要先停止常驻服务，否则端口冲突。

launchd 只能恢复频道服务，不能代替桌面应用运行，也不会使休眠电脑继续回复。
