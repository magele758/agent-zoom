---
name: zoom-inbox
description: 在当前 coding-agent 会话中将任务、进展、待决问题和结果汇入OPC OS Zoom 的同一消息列表，接收用户回复后在原任务继续。支持原生 Herdr 或其他工具派工，也支持直接委托OPC OS执行。
---

# 在 Zoom 消息列表协作

从当前项目目录调用 `opc-os`。首次连接时用 `opc-os connect /绝对路径/submit.env`，后续会话复用本机保存的连接。已有 KUNLUN_URL 和 WORKFLOW_SUBMIT_TOKEN 的执行环境可以直接使用。未安装命令的机器可用 `node "/OPC OS仓库绝对路径/scripts/zoom.mjs"` 代替。任务号、消息号和用户答复均从命令的 JSON 输出读取。需要定位消息列表时运行 `opc-os inbox`，用户要求打开时加 `--open`。

## 接收用户指定给你的工单

- 在已接入 OPC OS 的房间身份中，`wait` 返回 `stage_offer` 时，用 `delegated_work` 和通知的工单 ID 读取原事项、办理说明与验收条件。用 `claim_delegated_work` 传入宿主的稳定会话标识，取得 claimId。长任务用 `renew_delegated_work` 续租。用 `report_delegated_work` 提交进展、待人决定的问题或附证据的交付；重试复用同一 eventId。
- 任何具备本机 CLI 的 agent 也可运行 `opc-os stage list --agent 自己的名字 --status open`，加 `--wait` 可在当前会话等下一项，默认等 60 秒。用 `opc-os stage show 工单ID` 查看方法。名称应和用户委派时指定的执行人一致。用 `opc-os stage claim 工单ID --agent 自己的名字 --session 宿主会话标识` 认领，随后使用 `update`、`ask` 或 `done` 并传入 `--claim`；交付时附 `--evidence`。
- 执行者提交普通问题的答复或供本人审批的建议，证据和反馈始终留在原事项。重复派工、重复通知或意外重启都沿用原工单和认领。

## 立项先查已有开源能力

1. 用 `opc-os capability list` 查已登记接口，用 `opc-os capability discover '关键词' --owner magele758` 查公开仓库与 README，核对原仓的固定版本、样例和入口。发现尚未登记的能力可用 `opc-os capability import 能力.json` 登记。
2. 可以直接采用时，向 `opc-os capability request -` 提交 JSON，填写稳定的 `requestId`、使用方的 `product` 和 `project`、原能力的 `capabilityId`、`mode: "reuse"`、`title` 和 `detail`。需在消费项目接线时，先用 `opc-os opportunity add 候选.json` 登记候选，候选的 `capabilityRefs` 填能力 ID，再将返回的候选 ID 作为 `sourceOpportunityId` 带入采用记录。
3. 如果接口不足，用同一入口提交 `mode: "gap"`，写明现状、影响与验收办法。等待 Zoom 的版本审批。维护方用 `opc-os capability requests --repo owner/repo` 查看委托；双方用 `opc-os capability show 需求ID` 读取决定、关联计划与反馈。需要修改时用 `opc-os capability revise 需求ID 文件` 提交新版。批准的原仓需求归维护项目，执行前另批工程计划。

## 当前 agent 带队执行

1. 首次接到任务时登记一次。source 使用当前 agent 的名称，task 使用宿主中可重用的任务标识，例如会话 ID 加本次工单号。重试沿用原值。folder 是逻辑目录，可按“项目/模块”归类，省略时取当前仓库名。stage 是可选的产品阶段，登记时按实际归属传入。未分类的任务仍进入同一消息列表。将返回的 id 存进原任务的上下文。
2. 简单工作直接执行。需要多人协作时，先读仓库和约束，确定公共接口，按可独立交付的 Feature 写清归属路径、依赖、执行者、验收命令。向 Zoom 提交包含这些细节的计划问题，给出“批准”“要求修改”“拒绝”选项，按该问题的回答执行。收到修改意见就提出新版本，保留旧问题。空反馈时继续等待，有明确批准才启动受门禁的工作。
3. 使用当前宿主的原生协作能力派工。Grok 或 agy 在 Herdr 里可沿用各自已有的规划、按能力选 CLI、分屏和 worktree 流程。每条任务只选择一个调度者。向 Zoom 报告进展和确实需要人决定的问题。在多个 agent 之间共用同一任务时，传入相同的 Zoom 任务 ID，并为每个执行者的事件选不同标识。
4. 将 Zoom 返回的决定带回原任务。返工优先把反馈送给原 worker 和原工作树，例如在已有 hflow 批次内 fix；已失联时核对已有产物与宿主状态。独立 review 后，报告真实测试输出、差异位置和遗留项；需要最终验收时仍在同一任务发问。自由文本请求负责人批准时用 `opc-os ask ... --approval` 标明，执行者只能准备建议。只在实际结束后发送 done。用户明确授权的 Git 和清理操作按原任务约束执行。

在 Grok 的 Herdr pane 中，已批准任务可由原 router 启动一次 `herdr-split-tasks`。它先做必要的只读设计，再让实现分片各用一棵 worktree，最后只读 review。把 Zoom 任务号、需要报告的事件和验收约束传入任务描述，发起者保存返回的运行号。在 agy 中，主控按 Feature 难度选 CLI，给各 worker 写清可写路径，用 `hflow spawn --isolation worktree --wait` 派发；评审意见可通过 `hflow fix --wait -j <name> <反馈文件>` 送回原会话。这个模式收口时保留本地差异、分支和工作树。其他宿主有自己的委派工具时也沿用同一套消息约定。

```sh
opc-os start '修复库存同步' --source Grok --task 'thread-17/stock-retry' --folder '电商/库存' --stage development
# TASK 取上一步输出的 id。plans/r1.md 由当前 agent 编写，可通过 stdin 提交完整问题。
opc-os ask "$TASK" - --id plan-r1 --approval --choice 批准 --choice 要求修改 --choice 拒绝 < plans/r1.md
# QUESTION 取 ask 输出的 id，只等待这版问题；读取返回 events 的 choice 与 body。
opc-os replies "$TASK" --question "$QUESTION" --wait
opc-os update "$TASK" '修复已完成，原有回归测试通过，已交独立评审。' --id build-r1
opc-os done "$TASK" '评审与验收通过。相关证据在原任务的 review.md。' --id accepted
```

可以直接在 ask 上加 `--wait`，返回 message 和 feedback。等待默认 60 秒，超时返回空 events，可以用同一问题 ID 再等。需要接收原任务所有新答复时，调用 `replies "$TASK" <cursor> --wait`，处理成功后在原宿主保存 cursor。相同问题的网络重试复用 --id；不同轮次给新 --id。程序退出或 pane 空闲只影响会话状态，验收依赖实际证据和所需的人类决定。

发布授权、例外权限和最终验收都用 `ask --approval` 标明需要本人决定。本人可以委派 agent 准备建议，再从原问题提交决定。

## 交给OPC OS派工

选这条路径时，发起 agent 提交请求并接收反馈，后续节点由OPC OS调度，已有的 Grok driver、hflow 或其他调度器应当让出这次任务的派发权。任务本身会进入同一消息列表。

```sh
opc-os goal '修复库存同步' --request-id stock-17 --source agy --context 'thread-17' --folder '电商/库存' --stage development
opc-os feedback "$RUN" 0 --wait
```

RUN 取 goal 返回的 id。已有结构化计划可用 `opc-os submit plan.json`，顶层 folder 指定目录，stage 可填写产品阶段 ID。按版本要求用 revise 提交修改。用户在 Zoom 消息列表处理批准、退回和最终验收。

产品阶段 ID 依次为 `research` 信息收集、`idea` Idea、`prd` PRD、`design` 设计稿、`development` 开发组、`testing` 测试组、`release` 发布、`operations` 运维、`trace` Trace、`gtm` GTM、`acquisition` 营销推广与获客、`revenue` 营收、`accounting` 记账。

## 登记渠道转化记录

取得获授权的渠道登记、首次激活或订单记录后，按产品提交可核对的原始事件。每条记录填写 `product`、稳定的 `customerId`、`eventId`、带时区的 `at` 和来源标识 `reference`。获客事件用 `kind: "acquired"` 并填写 `channel`。激活事件用 `kind: "activated"`。支付订单用 `kind: "order"` 并填写稳定的 `orderId`，每笔订单提交一次。重试沿用整条原始记录。跨来源使用能核对的同一客户标识，缺少前置记录的事件可在报告中单独查阅。

下面是订单文件的结构示例。提交时填入业务系统中实际存在的值。

```json
{
  "product": "示例产品",
  "customerId": "demo-customer-7",
  "eventId": "demo-payment-45",
  "kind": "order",
  "orderId": "demo-order-19",
  "at": "2026-11-19T10:15:00+08:00",
  "reference": "示例支付台账/45"
}
```

```sh
opc-os growth record ./channel-events.json
opc-os growth record - < ./one-order.json
opc-os growth report 'OPC OS'
```

文件可以是单个 JSON 对象或对象数组。批量导入遇错时，输出列明已处理记录、失败位置及剩余数量，退出码为 1；修正来源数据后可重跑。用户可在 Zoom 的「渠道转化」点人数查看对应的客户、订单与来源。

## 项目目录与公开仓库

在「全局看板」查看各项目待办与阶段。只有项目名时先建立空目录，日后可关联仓库。经用户选定公开 GitHub 仓库后，用已连接 GitHub 的本机 `gh` 同步，`--product` 可把多个仓库归入同一产品。省略时使用仓库短名。同步只读取公开仓库，将仓库地址、所有者、fork 标记、开放 issue 和 PR 各自的总数及最近十条记录、最新 release 和采集时间保存到OPC OS。

```sh
opc-os project add '我的产品'
opc-os project list
opc-os project sync owner/repo --product '我的产品'
```
