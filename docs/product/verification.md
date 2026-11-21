# 验证到了哪里

以下运行结果整合自 2026 年 11 月 20–21 日的本机验收。当前版本已覆盖 7 层商业闭环中枢、公司四部（商业与治理/安全/运维/资源成本）、组织数字孪生全息沙盘、全站委派、自动选题、业务线打法库、项目讨论室与工作投入。各项验证使用的数据分别注明。[返回产品导读](../OPC_OS_PRODUCT_INTENT.md) · [看执行流程图](flows.html#execution) · [看商业闭环图](flows.html#commercial)

## 哪些真跑过

| 验收方式 | 核对到的结果 |
| --- | --- |
| 真实 Herdr + 真实 Codex | 临时 Git 仓库中，两次独立的 Codex 会话分别实现和评审，项目测试通过，最终验收写入 SQLite。[真实执行记录](../../data/workflow-validation/2026-11-20/codex-eb7eb77f/evidence.json) |
| 真实 Herdr + 固定脚本 | Chrome 看板配合四个 pane 和隔离工作树运行。未批准时零派发。退回 r1 后旧卡无法审批。重复提交和重启沿用同一尝试。第一次测试故意失败，返工通过，再独立评审。截图里的「修正问候语」属于这类演示。[返工记录](../../data/workflow-validation/2026-11-20/herdr-056b2b0e/evidence.json) |
| 模拟宿主与故障 | `local-demo` 用本地子进程代替 Herdr，仍使用 Git、SQLite、浏览器和项目测试。另有故障注入覆盖缺回执、并发认领和旧快照。自动回放使用测试身份审批。[演示命令与完整验收范围](../WORKFLOW_UPGRADE.md) |

固定脚本演示的审批意见保存在原请求，发起者可用 CLI 取回。真实 Grok 或 agy 原会话能否直接续接，要在绑定该会话后单独验收。

## 首版新增验收

| 场景 | 验证内容 |
| --- | --- |
| 跨开源项目复用 | 实际用 GitHub 搜索找到两个 ChromeGate 公开仓库，读过首批六个项目的固定版本。ChromeGate Gateway 原仓的场景预检运行通过。临时库和 Chrome 覆盖登记版本、使用方直接采用、向维护方提需求、退回修改、批准新版与回看历史。店铺草稿和维护需求是演示数据。[原仓预检](../../data/opc-validation/gateway-preflight.json) · [审批记录界面](../../data/opc-validation/capability-request.png) |
| 研发自动选题 | 公开 GitHub Issue、发布说明及选中日记摘录可导入，重复来源去重。本机读取过真实公开 release。临时仓库从自动选题到真实 Herdr 和 Codex 实现、独立评审、最终验收已整链通过。[本轮双 Codex 回执](../../data/opc-validation/herdr-codex-selection.json) · [四次尝试的返工记录](../../data/opc-validation/herdr-scripted-rework.json) |
| 可选 coding agent | 三个独立临时工作树分别跑过 Grok、Antigravity 和 Cursor Agent 实现，另用 Cursor ask 只读评审。四次均单独执行项目检查，退出码为 0。真实 Herdr 分别跑通了 Grok 和 agy 实现、Cursor 独立评审与最终验收。agy 会在需要时读取当前可用模型，在回执里记录本次使用的模型。[CLI 差异和检查](../../data/opc-validation/cli-agent-real-checks.json) · [Grok → Cursor 回执](../../data/opc-validation/herdr-grok-cursor-selection.json) · [agy → Cursor 回执](../../data/opc-validation/herdr-agy-cursor-selection.json) · [配置与演示](cli-runners.md) |
| 不同业务线、同一份 Zoom | 真实浏览器在独立 SQLite 中新增一条店铺线、关联演示插件、登记实验及观察，再把同一观察交研发。研发候选可点回原实验，复盘回答写回同一任务。没有使用真实店铺、交易或发布权限。 |
| 公司目录 | 真实 daily-review-learning 原文已只读验证。临时日记演练一个想法关联两个产品、新建子项目、重复生成候选、从想法和子项目进入具体阶段。保存项目层级、领域及跨项目复用的版本与用途。 |
| Agent Home | 真实 botRoomsRoutes 和 BotRoomService 使用临时房间、两个测试 Bot 和独立数据库。两轮针对原问题的点名讨论均得到回执。固定文本代替模型生成答复。额外测试覆盖回执丢失后的分页对账。Chrome 也实测了界面绑定、点名、Zoom 引用回复与打开原讨论。运行 `npm run build && node --import tsx scripts/opc-room-demo.mjs --browser` 可重放。 |
| 个人 Agent Hub | 采用本机按日期的公开工作快照格式。Chrome 使用合成日报验证人工关联业务线和子项目，反复读取保留一份关联。没有导入个人会话。 |
| 渠道与营收 | 用合成数据验证渠道、激活、首单、复购和交易去重。店铺实验按来源登记收款、退款、费用并分币种计算净流入；真实经营归因由业务线接入的证据决定。 |

[本机启动与重放命令](start.md)

从演示的店铺实验点「本轮资产」可以进入真实的 ChromeGate 接口版本，继续点维护需求即可到同一条 Zoom 审批。这个页面可以在桌面和手机上走查。[实际版本页面](../../data/opc-validation/gateway-adoption.png) · [维护需求审批](../../data/opc-validation/capability-approval.png)

## 建议的下一个试点

用OPC OS负责自己的「从日记引用到项目 room」特性，再把做法用到第二个开源项目。这样能检验二月提出的自举思路。[二月的发展计划](https://github.com/magele758/knowledge-2-business/blob/497ee275cb43b61b61419c804265398cff057a77/DEVELOPMENT_PLAN.md#L330-L357)

1. 选一条真实日记，在测试 room 点名一个 Home Bot，核对带出处的原帖答复。只看 Zoom 回答一次澄清，重连后仍只有一问一答。显式转为任务才增加一项交付。
2. 在项目中提交计划、批准版本、实现并独立复测。验收时从 room 点回原文，重复引用找到原讨论。获得发布授权后核对真实使用反馈，仍在等待时保留这个状态。
3. 第二个项目引用第一份成果或已验证流程，保留自己的条件和验收。回到同一想法能分别看到两个项目做过什么、投入多少、结果如何、下一步轮到谁。

### 试点里要对齐的三个选择

- 用哪两个真实项目来校准你的层级、领域和复用习惯？
- 每个 room 由谁接话？建议先由人或 coding agent 明确点名，主持 Bot 的主动协调可以按项目选择。
- 每类意见默认发给谁？建议计划意见回到发起者，返工回到原执行者，每次发送前显示目的地。

## 工作索引与全站委派

- 工作索引的接口回归使用独立 Git 仓库、worktree 和测试账号，覆盖身份切换、失去 GitHub 连接、移动工作目录、固定提交的 README 和库内搜索。正式索引的刷新时间与每个来源的可用状态可在「工作索引」核对。
- `node --test scripts/delegation-flow.test.mjs` 启动独立服务，从另一个目录通过本机 CLI 提问、按指定名字认领，中途重启服务，再交回带证据的答复。测试还启用后续待办的自动办理，让执行者对一条审批提交建议，由测试操作者回答原问题。
- `node scripts/activity-index-browser.mjs` 检查桌面与窄屏的索引、仓库内容、委派入口、办理方式、委派台状态筛选、频道委派工单链接、原审批、想法 ↔ 项目讨论室 ↔ 阶段工作单双向跳转，以及阶段工单租约超时后的重新开放认领。浏览器用例使用固定返回，真实本机仓库和 Bot 都可以从正式界面只读核对。
- 工作流验收与清理：`npm run test:workflow`、`npm run test:opc`、`npm run test:zoom` 与 `npm run test:browser` 在退出后自动清理各自创建的 Herdr 终端/空间与临时目录（加 `--keep` 可保留现场）；最终验收默认清理临时 worktree 与 Herdr 终端并保留回执与差异，另提供 `opc-os cleanup <run-id>` 和 `npm run workflow:cleanup` 手动收尾。

## 商业闭环、公司四部与组织数字孪生（2026-11-21）

| 能力域 | 验证内容与产物 |
| --- | --- |
| 全量自动化测试与类型检查 | `npm run typecheck`（服务端 + 前端双 tsconfig）通过；`npm test` **247 项测试全部通过**（含商业中枢、安全/运维/资源部门、工作流 DAG、全站委派、项目讨论室、开源能力复用、工作索引与频道协议）。 |
| 7 层商业闭环与伴生服务 | `src/commercial.test.ts` 与 `npm run opc:verify` 验证 18 项 L0–L6 蓝图资产一键纳管、5 套业务线打法库立项、6 大伴生服务健康探针与端到端首单闭环（UTM 获客 → 激活 → MoR 订单入账 → Ed25519 离线 OPCL1 签发验签 → DuckDB 17 列 Trace 漏斗同步）。[商业驾驶舱截图](../../data/opc-validation/opc-commercial-cockpit.png) |
| 公司四部与全局看板修复 | `src/security-department.test.ts`、`src/operations-department.test.ts`、`src/resource-department.test.ts` 覆盖安全评审/整改复审、服务端点健康检查与版本台账、Agent Hub 额度窗口与手动订阅账单；全局看板多列对齐与 13 阶表头已完成浏览器截图回归。[全局看板截图](../../data/opc-validation/overview-fixed.png) |
| 组织数字孪生全息沙盘 | 浏览器验证 `#digital-twin` 三透镜（全息空间沙盘 22 舱室、双闭环价值流、35 入口全功能星图）、昆仑夜航与宣纸堪舆双画布风格、信号回路筛选及十三阶全生命周期价值传送带。[夜航沙盘](../../data/opc-validation/digital-twin-night.png) · [宣纸沙盘](../../data/opc-validation/digital-twin-paper.png) · [双闭环视图](../../data/opc-validation/digital-twin-loops.png) · [全功能星图](../../data/opc-validation/digital-twin-atlas.png) |
