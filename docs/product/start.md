# 第一次使用 OPC OS

## 一键拉起 OPC 全栈工作台（推荐）

如果你想一次启动 OPC OS 本体、自动拉起商业伴生服务（Commerce / GTM / Ops / Data Analysis）并纳管公司 7 层全景资产，直接运行：

```sh
npm run opc:up
npm run opc:stack -- status   # 查看 6 大服务健康状态、1 号试点就绪度与经营指标
npm run opc:verify            # 演练一次端到端首单商业闭环（UTM获客 -> 激活 -> 离线License -> DuckDB漏斗）
npm run opc:stack -- stop     # 停止由 stack 自动拉起的附属后台服务
```

命令行会打印本机商业驾驶舱（`/#commercial`）、公司业务线（`/#business-lines`）和统一消息列表（`/#inbox`）地址，并自动执行 `opc-os connect`。也可通过 `npm run opc -- commercial overview|bootstrap|ensure|closed-loop|sync-analytics|playbook <模板ID>` 直接操控商业闭环。

## 仅启动本机 OPC OS 工作台

若只需要 OPC OS 主体与持久项目库，运行 `npm run opc:start`，打开启动器显示的本机地址。首次使用 CLI 可运行 `npm run opc -- connect data/zoom-local/submit.env`。

- [组织数字孪生](http://127.0.0.1:52328/#digital-twin)将决策脑枢、多 Agent 产研工坊、商业四部、十三阶价值流与底层微服务映射为实时全息沙盘（支持昆仑夜航 / 宣纸堪舆双风格、双闭环价值流与 35 个全功能星图检索），点击任意舱室一键直达。
- [商业与治理部](http://127.0.0.1:52328/#commercial)提供一键纳管 7 层 18 项资产、拉起 6 大伴生服务、演练首单闭环、签发/验签 Ed25519 离线 License、生成门面与 UTM 推广包、分诊客服工单及同步 DuckDB 漏斗。
- [会话与仓库索引（本机会话）](http://127.0.0.1:52328/#activity-index?view=agents)按来源列出本机 coding agent。点一条可看工作目录和关联仓库。在索引、总览或数字孪生打开时，每 15 秒读取一次活动。Herdr 自报的执行状态、Agent Hub 的最近活动和仅由进程确认的在线线索分别显示。
- [会话与仓库索引（仓库视图）](http://127.0.0.1:52328/#activity-index?view=repos)汇合当前 GitHub 账号、自有与协作仓库、近期公开贡献、本机 Git 与 worktree。正式服务每 15 分钟更新索引和已纳管公开仓库的 Issue、PR、Release，也可以手动刷新。点仓库读取 README、根目录或搜索已提交内容。项目的业务归属沿用项目目录中的登记。
- [委派台](http://127.0.0.1:52328/#delegations)保存常用执行人和办理说明。可逐条指派，也可开启后续待办的自动委派。订阅收件箱的具名 coding agent 可直接接到通知，其他 CLI 按指定名称认领。Agent Home 使用选中的 Bot 接单。执行人可直接办结普通问题，需要你确认时带着建议与证据回到「待我处理」。

## 在临时项目里走一遍

在仓库根目录运行以下命令。它会新建 Git 仓库和独立数据库，打印公司总览、店铺线和第一份待批计划的地址。演示保留工作树和回执，以便结束后查看。

```sh
npm run opc:preview
```

1. 打开「全局看板」。点「店铺运营」，打开合成草稿的实验。点「本轮资产」里的 ChromeGate Gateway 可查看实际引用的原仓版本和接口。返回实验，选「到 Zoom 处理复盘」，写下继续、调整或暂停的理由，再点「返回经营实验」。
2. 在实验中选「从观察提出研发特性」，指定项目 `Demo/Greeting` 和某条观察。打开候选能回到这份证据。示例公司只有一个绑定了工作树的研发项目。
3. 在「研发选题」里查看排在前面的问候语修复。项目开启自动选题后一次选择一项。打开计划，检查本版执行者、依赖和验收条件。在 Zoom 批准后，真实 Herdr 和两个独立 Codex 会话会依次实现、评审。手动确认最终验收。
4. 想从阶段直接发起工作时，进入「产品进程 → 测试组」，选择 Demo 下的 Greeting，可编辑测试目标、材料和验收方法。给 coding agent 的工作单由其原会话认领；给 Home Bot 的工作单要选定具体 Bot 并点击派工。房间讨论另从「项目讨论室」点名。
5. 打开「开源能力」→ ChromeGate Gateway，查看「店铺实验 / 草稿检查」引用的真实提交。点开演示维护需求，从 Zoom 要求修改、拒绝或批准，返回原需求看反馈。演示中的 ChromeGate 保留为未绑定工作树的维护项目，批准后可以在该项目看到维护候选。[复用命令与来源](reuse.md)
6. 关闭预览用 Ctrl-C。无须启动 Herdr 的版本可用 `npm run build && npm run opc:demo -- --interactive`，这时界面会标明本地演示执行器。

## 接入自己的几条业务线

```sh
npm run opc:start
npm run opc -- connect data/zoom-local/submit.env
```

第二条在另一个终端运行一次，供本机 CLI 查找服务。浏览器打开第一条打印的本机地址即可处理决定。本文命令都可直接从此仓库执行；希望在任意目录使用 `opc-os` 命令时，可在仓库根目录执行 `npm link`。

- **公司共用资料**。在「信息与想法」按日期读现有 daily-review-learning 的全文，选段可送入 Learn Agent。写下「想验证什么」并保存后，可以直接挑产品和项目发给研发，前往打开计划。可用 `OPC_DAILY_REVIEW_DIR` 指向另一台机器上的同一个日记库。一条想法能给几个产品下的不同项目分别产生研发候选。
- **目录与复用**。在「项目目录」建产品，在该产品下登记项目。展开子项目填层级和领域，可引用另一项目的版本或证据，留下采用方的用途。GitHub 公开仓库的接入命令是 `npm run opc -- project sync owner/repo --product 产品名`。
- **工程自动选择**。执行服务需要有基线提交的本地 Git 仓库，在配置的 `projectWorkspaces` 中登记项目名与路径。默认两个独立角色使用 Codex。内置 Grok、agy 和 Cursor Agent 的实现适配。独立评审可用 Codex 或 Cursor 的只读模式；审批前调整节点执行者将产生新计划版本。[执行者配置](cli-runners.md)持久服务可在 `data/zoom-local/service.env` 中指定 `WORKFLOW_CONFIG`，或在启动新服务时运行 `OPC_WORKFLOW_CONFIG=/absolute/path/workflow.json npm run opc:start`。已运行的服务需重新启动才会读新配置。[执行配置和回执协议](../WORKFLOW_UPGRADE.md#接入实际项目)
- **由任意 coding agent 发起**。例如在该 agent 的会话里调用 `npm run opc -- goal "修复同步" --request-id stock-17 --source grok --project "电商/库存" --context "thread-17"`。结构化草案可用 `submit`，项目键为 `projectKey`。
- **持续吸收特性与维护问题**。把目标项目替换为已绑定的键，用下列命令在前台轮询已登记仓库。可单独指定参考的公开上游仓库，只抽取其新版本。想法、Issue 或 release 成为候选后，在界面开启该项目的「自动选题」。依据为影响、把握、投入及源材料，结果可跳过或交回修改。

```sh
npm run opc -- sources github --repo owner/repo --project '产品/项目' --watch 900
npm run opc -- sources github --repo owner/repo --project '产品/项目' --upstream another/upstream
npm run opc -- sources daily /absolute/path/2026-11-20.md --heading '小节名' --project '产品/项目'
```

- **店铺与其他新业务**。在「公司业务线」新增一条线，写自己的目标和流程。可登记多个插件及版本，开启实验后本轮使用的配置会留存。通过界面或 `npm run opc -- business evidence <实验ID> observation.json` 登记原始观察、收款、退款或费用。插件接入时为同一条回执提供稳定的 `eventId`，金额按币种以最小单位整数保存。实盘读店、改价及上架由具体插件和该项工作的授权决定。观察文件示例为 `{"eventId":"draft-42-v1","kind":"observation","note":"草稿缺少规格","reference":"测试店/草稿42/检查v1"}`。
- **个人投入**。在「工作投入」选日期，手动将公开日报条目归到业务线和项目。工作快照默认来自 `~/.agent-hub/daily`，可用 `OPC_HUB_DAILY_DIR` 指定路径。
- **反馈去向**。Zoom 显示问题/版本和接收方。一般 CLI 任务用 `npm run opc -- replies <任务ID>` 取回反馈；频道回复进原频道。绑定 Home 房间后，回复会按房间、被点名的成员和原消息投递，送达不明时在原讨论对账。Herdr 的 pane 和工作树会保留到你处理现场为止。

## 重放验收

```sh
npm run typecheck
npm test
npm run test:opc
npm run test:zoom
npm run test:workflow -- herdr
npm run opc:demo -- --herdr --codex
```

`test:workflow -- herdr` 使用真实 Herdr 搭配固定执行脚本，覆盖旧版审批、重启及失败返工。`opc:demo -- --herdr --codex` 使用真实模型实现和独立评审。两种自动回放都只在各自临时库里使用测试身份批准。界面预览的审批留给操作人。
