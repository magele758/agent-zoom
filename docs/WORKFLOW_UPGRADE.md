# OPC OS中控升级

日常入口是 [Zoom 消息工作台](ZOOM_INBOX.md)。各个原生会话可以只登记和上报，交给OPC OS执行的工作流也在同一个列表发来决定。目录从提交时的工作主题派生。以下介绍需要 Herdr 执行时的计划、调度、回执和验收。

## 现状与分工

现有协调器把模型建议存入 SQLite，经确认后发到频道任务系统。频道已有认领、租约、交付和评审记录，流水线的返工规则固定，`gate` 可见但没有独立、可追溯的阻断决定。保留这套入口和状态，新工作流以自己的运行 ID 在同一 SQLite 中增量落地。一个工作项选择其中一个入口。

任何能调用本地 CLI 的发起者均可提交目标、约束与请求上下文，也可提交自己的 DAG。OPC OS验证草案、记录计划和决定、调度依赖、对账、重试及回收结果。Herdr 根据OPC OS分配的 attempt 提供会话定位，工作在固定基线的隔离 Git worktree 中。Herdr 的终端状态仅用于对账。独立 review 使用单独的执行角色和 worktree，读取上游留存的差异、测试证据和反馈。

### 首版功能与现有 Herdr 流程对照

| 用户动作 | OPC OS已经实现 | Grok、agy 原工作流中的体验 |
| --- | --- | --- |
| 在当前任务里派工 | 任意本地 CLI 可提交目标、约束或完整依赖图，拿到运行 ID 和看板链接；同一请求可重复提交 | Grok pane 中用一句 `/herdr-split-tasks <需求>` 启动具名工作流。agy 在 Herdr 主会话中按任务规模自动分流，小改当场做，大任务拆 Feature。这两个原入口目前都不经过OPC OS。 |
| 形成分工 | 默认规划从目标生成实现、自检和独立评审两个节点，支持提交更复杂的计划或调用可选模型规划器。OPC OS校验依赖、版本和评审覆盖 | Grok 的只读 planner 先看仓库，按功能与文件归属最多分 8 片，按需设计、并行实现、只读评审。agy 先定公共接口，再给 2–4 个 Feature 各写目标、路径边界与验收命令。 |
| 选执行者 | 审批前可为实现节点选择已配置的执行器；适配 Codex、Grok、agy 和 Cursor Agent，独立评审使用 Codex 或 Cursor 的只读模式 | Grok 要求 driver 按设计/评审、难实现、简单实现三组独立轮转 CLI。agy 由主控按高、中、轻三档选择 Codex、agy、Grok、OMP 或相应模型的 Cursor，再将明确的 runner 交给 hflow。两边都允许子 CLI 使用自己的 subagent。 |
| 看工作、接着说话 | 每次尝试一个 Herdr tab 和隔离 worktree；内置 Codex 用非交互 `exec`，输出写日志。pane 提供任务链接 | Grok 在发起 pane 旁向右、向下放前两个交互式子 CLI。agy 的 auto 布局在三个及以下任务时分屏，四个及以上用具名 tab；各 worker 保有自己的对话。 |
| 审查、返工、接收反馈 | 保存差异、退出码、测试输出，在独立工作树重放差异做 review。失败后新建 attempt，恢复上次草稿；原任务可用 CLI 游标取反馈 | Grok 让实现者读取设计报告，子 CLI 将报告路径发回父 pane，reviewer 逐棵检查工作树。agy 由外层主控审改动、跑测试，`hflow fix` 按 worker 名找到仍存活的原终端，把意见送回同一会话、同一工作树。 |
| 决定与恢复 | OPC OS看板显示当前阶段、责任方、证据与历史；支持按版本批准、退回、拒绝和最终验收。SQLite 持久化认领和租约，重启先对账 | 这部分来自OPC OS中控要求。Grok 的 driver 遇阻会停住后续波次；hflow 的 ready 信号交给主控继续审查。OPC OS保留独立回执和人工验收。 |

现有 Grok 路由只调用具名 Rhai workflow 一次。Rhai 显式调用只读 planner、过滤切片，再交给可执行的 driver。模型轮转、窗口布局和结果回传写在 driver 指令里。agy 的自动分流与难度判断写在规则和 skill 里，hflow 负责执行已选定的派工、保存终端与轮次、等待和原地返修。OPC OS当前通过 hc 单独启动 worker；原入口、父子会话和原地续聊尚待接入。（本机路由参见 `~/.grok/skills/herdr-split-tasks-router/SKILL.md`、`~/.grok/workflows/herdr-split-tasks.rhai`、`~/.agents/skills/herdr-flow/SKILL.md` 与 `~/.local/bin/hflow`。）

## 状态与迁移

- Run 记录原请求和固定 Git 基线。Plan revision 留存完整 DAG、变更说明和需要重新确认的节点。初次确认前所有执行节点均受阻。
- 人工决定绑定运行、revision 和具体卡片。确认放行对应节点，要求修改或拒绝将反馈送回原运行。新 revision 只能更改尚未启动的节点，变更沿依赖传播，未受影响且已经批准的节点可继续。最终验收取当前 revision 选定的 review 证据。
- NodeAttempt 在调用 Herdr 前持久化。启动回执不确定则按稳定标签对账，继续等待或由操作者恢复。完整回执推进成功或失败，已结束且缺少回执进入待恢复。重复回执不重复推进，新 attempt 始终拥有新标识，旧证据保留。重启后从 SQLite 和本地回执目录继续对账。
- 看板阶段与责任方各自展示。卡片聚合计划、问题、attempt 证据及决定历史。打开页面不会改变门禁。最终验收只关闭当前运行。
- SQLite 迁移新增工作流表，旧频道数据原样读取。运行和回执目录归同一个本地服务负责。验收不触发 Git 合并、推送或部署；最终验收卡默认勾选「批准后清理 Herdr 终端与临时工作树」，也可在已完成或已拒绝的运行上手动点「清理终端与工作树」或执行 `opc-os cleanup <run-id>`，清理时保留回执、差异与 SQLite 记录。

看板参考 Plannotator 在同一 commit 中的线程状态、决定写入和看板展示。[线程状态](https://github.com/backnotprop/plannotator/blob/f61d44dc304ad15ce68cb71acace3abbf3346de0/adr/implementation/inbox-thread-state.md) [持久层](https://github.com/backnotprop/plannotator/blob/f61d44dc304ad15ce68cb71acace3abbf3346de0/packages/shared/inbox/store.ts) [看板](https://github.com/backnotprop/plannotator/blob/f61d44dc304ad15ce68cb71acace3abbf3346de0/packages/inbox/board/BoardPage.tsx)

## 路线图与验收

### 首版实施顺序

1. 先固定提交与审批协议。发起者带稳定请求 ID 和原任务上下文提交目标或 DAG，取回 run ID、当前计划版本及看板地址。规划可复用OPC OS已有的只读协调器，也支持本地规则生成和直接提交结构化计划。三条路径经过同一套依赖和验收覆盖校验。
2. 在 SQLite 事务中确定可执行节点并认领 attempt，持久化后再调用宿主。一次运行只有OPC OS有权推进依赖。认领过期、服务重启、终端退出都先按 attempt ID 对账。失败后保存差异、检查输出和原始回执，人工返工创建新 attempt。
3. 用配置把实现节点的能力名绑定到本机执行命令。独立评审使用单独的 runner 和 worktree，从已收取的实现差异重建待审内容。CLI 发起者用 run ID 和游标从原任务取回决定、批注和返工理由。
4. 看板以任务为入口，同时给出当前阶段、责任方、版本、待决事项及其证据。已读与归档单独保存。每个 Herdr 运行提供看板定位入口。验收完成后保留执行现场。
5. 在临时 Git 仓库跑两种演示。自动验收用固定输入复现重复提交、拒绝旧版本、重启和失败返工；交互演示将同一流程停在真实审批卡，供人逐步确认。区分执行宿主、工作器和审批者的测试范围。

AutoSwarm 把任意能运行本地命令的 agent 作为入口，并为每次调用单独保存回执，原生会话继续保有自己的历史。OPC OS据此在 CLI 和看板间传递稳定 run / attempt ID 和原任务上下文，执行命令由本地能力配置决定。AutoSwarm、Maestro 与 Hyper Vibe Kanban 都未被注册为此流程的调度器。[AutoSwarm 项目](https://github.com/HKUDS/AutoSwarm/tree/fe635317a1a4dc60940d778cb8ec8d58644e0b98) · [调用回执实现](https://github.com/HKUDS/AutoSwarm/blob/fe635317a1a4dc60940d778cb8ec8d58644e0b98/src/autoswarm/records.py)

首版在一个配置过的本地项目中支持一次有限 DAG、独立评审和人工验收。验证包括文件与 stdin 两条发起路径、确认前零启动、依赖阻断、不可变的已启动节点、旧卡片和旧回执、断线对账、失败重试和刷新回放。演示用临时 Git 仓库、固定 worker 和独立 review，分别记录真实 Herdr 与测试替身的范围。

后续 Agent Terminal 接同一工作流接口，作为另一执行和交互宿主。Hyper Vibe Kanban/Maestro 可提供工单或执行后端。同一个 run 由OPC OS维护唯一调度状态。复杂循环、触发器、跨机器执行和多租户授权留在后续。

## 在临时仓库演示

从OPC OS仓库根目录运行。沿用本项目的 Node.js、npm 和相邻的 ppeng-agent-core 依赖。真实桌面演示需要已启动的 Herdr，以及 PATH 中可用的 hc 和 herdr-app。

```sh
npm run workflow:demo -- herdr
```

1. 打开命令输出的任务链接即可查看计划。在同一服务的新窗口也能打开这条运行。计划卡显示两项并行实现和一个依赖两者的评审。此时尝试数为零。
2. 批准计划。Herdr 会出现以运行 ID 命名的空间，每个尝试各有页签和工作树。说明文档成功交付，问候语的第一轮故意测试失败。展开失败记录可看实际测试输出与差异。
3. 在失败记录中写下“修正问候语后重跑测试”，点「重试」。OPC OS保留第一轮证据，新建一次实现尝试。两条分支都通过后，独立评审在自己的工作树核对两份改动并重跑测试。
4. 点最终验收卡的 review 链接查看依据，再点「批准」。默认清理该次运行的临时 worktree 与 Herdr pane/空间，同时保留数据库与回执目录；如想保留 pane 排查，可在批准前取消勾选，或在已完成运行上稍后点「清理终端与工作树」。主检出仍在演示基线。
5. 在启动终端按 Ctrl+C 可停OPC OS；演示与自动验收脚本退出时默认自动清理本次临时目录和 Herdr 终端，如需保留现场用于重开服务可附加 `--keep`。日常也可用 `npm run workflow:cleanup`（支持 `--dry-run`）一键清理残留测试终端与临时目录。

完整的自动回放通过 Chrome 操作同一套看板。它还会退回第一版计划、检查旧审批被拒绝，在实现运行中重启服务，并留存截图、状态和证据。桌面版会核对实际 pane。

```sh
npm run test:workflow -- herdr
npm run test:workflow -- local-demo
```

若要现场让模型修改临时项目，可运行 `npm run workflow:demo -- herdr --codex`。此入口使用本机已登录的 Codex CLI 和模型额度。提交的是问候语目标，由本地规划器生成两步计划。批准后两个真实模型会话分别实现和只读评审，独立执行项目检查。固定脚本演示中的故意失败仅用于稳定复现返工。

## 从任意 coding agent 发起

发起者只需要本机 CLI 和该项目的提交密钥。在上述演示中把 DEMO_DIR 替换成启动输出中的临时目录。将 request-id 保存在原任务，网络重试时沿用同一个值。context 可填写聊天、工单或任务 ID，方便把反馈对应回去。

```sh
DEMO_DIR=/tmp/kunlun-workflow-实际目录
workflow() { node --env-file="$DEMO_DIR/submit.env" scripts/workflow.mjs "$@"; }
workflow goal '完善问候语和测试说明' --request-id greeting-17 --source my-agent \
  --context 'my-agent/task-17' --constraint '保留既有测试'
RUN_ID='替换为上一步返回的 id'
workflow status "$RUN_ID"
workflow feedback "$RUN_ID" 0 --wait
workflow board "$RUN_ID" --open
```

RUN_ID 取自提交结果的 id。发起者可递增读取 feedback，下次传上一次结果的 cursor。加上 --wait 后，原任务的 CLI 调用收到新反馈即返回，单次最多等待约一分钟。事件保留原任务上下文、计划版本、卡片或尝试 ID、操作者和反馈正文。发起端关闭后重开也能接着读。完整结构化草案支持文件和标准输入。修改请求由发起者提交，格式为 `{"baseRevision":1,"reason":"修订依据","plan":{...}}`。服务将受影响的未启动节点送回审批。

```sh
workflow submit - < "$DEMO_DIR/request.json"
workflow revise "$RUN_ID" revision.json
```

## 接入实际项目

示例工作流使用固定 runner 复现返工。正式工作流可选择内置的 Codex runner，或按相同协议配置已安装的其他 CLI。示例配置里的工作目录需要是有基线提交的 Git 仓库。将适配脚本换成本仓库的实际绝对路径，测试命令换为该项目的检查命令。

```json
{
  "workspace": "/absolute/path/to/project",
  "projectWorkspaces": { "产品/项目": "/absolute/path/to/project", "另一产品/插件": "/absolute/path/to/plugin" },
  "backend": "herdr",
  "planner": "local",
  "implement": ["node", "/absolute/path/to/agent-chatroom/scripts/workflow-codex.mjs", "implement", "node", "--test"],
  "review": ["node", "/absolute/path/to/agent-chatroom/scripts/workflow-codex.mjs", "review", "node", "--test"]
}
```

```sh
export WORKFLOW_CONFIG=/absolute/path/to/workflow.json
export WORKFLOW_SUBMIT_TOKEN="$(openssl rand -hex 32)"
npm run build && npm start
```

重启时使用同一份服务配置和 CLI 提交凭据。服务默认使用 data/chatroom.db 和 8791 端口，可通过 DATA_PATH 和 PORT 指定。发起 CLI 使用 WORKFLOW_SUBMIT_TOKEN，浏览器首次打开时自动连接本机服务。CLI 和 worker 通过 `KUNLUN_URL` 或任务的 `boardUrl` 定位本机服务。新项目在 projectWorkspaces 里登记对应的本机仓库。执行前固定该次运行的工作区；更改绑定后，旧运行需恢复原绑定才能继续。

默认 local 规划器把目标和约束纳入“实现、自检 → 独立 review”两步计划。需要按目标拆成多个节点时，可提交 DAG，也可设 `planner: "coordinator"` 使用项目现有的模型连接生成 DAG。模型配置沿用 ppeng-agent-core 的 .env 或 COORDINATOR_ENV_FILE，模型不可用时提交端收到错误。每份计划最多 12 个节点。implement 节点可通过 capability 指定配置中 capabilities 表内的 argv；review 单独配置。

### 执行器与恢复

- 执行协议只要求宿主支持 launch 和按稳定 attempt ID 查询状态。OPC OS先在 SQLite 中认领，再准备 worktree、调用宿主；重启后重新读取同一个数据库与 attempt 目录。未来 Agent Terminal 可以实现同一接口。
- OPC OS调用管理员配置的 runner 时会在 argv 尾部追加 payload 路径和结果路径。payload 含原请求、具体节点、工作树、已保存的上游证据、反馈和看板地址。runner 在结果路径写入 outcome、summary、checks、artifacts。checks 包含 name、exitCode、output，artifacts 包含 name、content。OPC OS worker 核对结构、实际进程退出码，并独立提取 Git 差异。内置 Codex runner 会另起会话，并亲自执行配置的检查命令。
- 下游从固定基线按依赖顺序回放各成功节点留下的增量差异。重叠改动无法干净应用时保留工作树和错误，交回看板。一次有效回执须对应具体 run、node、attempt 和 revision。先收到回执也可以完成对账；终端继续处于打开状态时仍可查看现场。
- 遇到待对账尝试，先恢复相同 Herdr 配置，按 attempt 标签定位终端，检查对应目录的 receipt.json。未领取的派发可以人工封存；已领取但宿主记录消失时，先找回记录或有效回执。显式封存、写下反馈后才可新开尝试。
- 同一宿主上的执行命令有变化时，OPC OS继续收取旧尝试的回执。看板会提示发起者提交新版本并重新审批，随后才允许用新命令派发。
- 已失败的实现可重试。独立评审发现实现缺陷时，发起者按评审反馈补下游修复节点，再接一轮独立 review，并将新 review 指定为 acceptance；旧实现、旧评审和原证据继续可查。每版最终验收都由人确认。

## 2026-11-20 本机验收

| 路径 | 实际执行 | 观察结果 |
| --- | --- | --- |
| Herdr + Codex CLI | 两个独立的真实 Codex 会话，分别在 t6r、t6s 中执行 | 从目标生成计划，修复 sum.mjs，在独立工作树只读评审并复测。两次项目测试都返回 0，最终验收已写入 SQLite。 |
| Herdr + 固定演示 runner | 真实 Herdr 桌面、四个 pane、四个 Git worktree、Chrome 看板 | 无审批零派发。r1 被退回，r2 生效后旧卡返回 409。重复提交和运行中重启沿用同一任务、尝试与终端。首次检查退出 1，返工退出 0。review 验证两份差异后验收。 |
| local-demo | Node 子进程代替 Herdr，Git、SQLite、Chrome 和项目测试照常运行 | 相同流程通过，已读和归档操作保留审批与证据；新反馈可从原任务的 CLI 取回。 |
| 故障注入 | 临时 Git / SQLite，执行宿主或模型回复使用测试替身 | 验证双控制器并发、错放回执、终端退出无回执、旧快照、替换 runner 时的重新审批、下游修复和二次评审。 |

以上自动回放由测试身份操作审批。两条 Herdr 路径都有独立的运行记录和实际测试输出。[真实 Codex 记录](../data/workflow-validation/2026-11-20/codex-eb7eb77f/evidence.json) · [Herdr 返工记录](../data/workflow-validation/2026-11-20/herdr-056b2b0e/evidence.json) · [Herdr 桌面布局](../data/workflow-validation/2026-11-20/herdr-056b2b0e/herdr-layout.json) · [验收截图](../data/workflow-validation/2026-11-20/herdr-056b2b0e/03-acceptance.png) · [子进程记录](../data/workflow-validation/2026-11-20/local-demo-dd77fe79/evidence.json)

全量测试 149 项通过，原有浏览器回归 19 项通过。服务端与前端类型检查、生产构建、工作流脚本语法检查和 git diff --check 均通过。项目没有配置 lint 脚本。另行调用现有协调器的远程模型生成计划时，供应商返回 HTTP 401，原因为余额不足。本机已验证目标规则规划、草案校验，以及使用固定模型回复的协调器 SDK 工具调用。
