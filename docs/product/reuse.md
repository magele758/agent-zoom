# 已有能力怎么用，缺什么交给谁

OPC OS 管公司项目之间的委托和交付。仓库维护方掌握自己的源代码、接口和发布节奏。研发选题和店铺实验都可以作为使用方，同一版本能被多个项目采用。

公司已经接入的几项分工如下。

| 已有项目 | OPC OS 从哪里接入 | 仍由原项目负责 |
| --- | --- | --- |
| daily-review-learning | 读取你选中的日期、小节和出处 | 日常信息收集与原文维护 |
| Agent Hub | 读取指定日期的工作看板快照，记录事项属于哪条业务线 | 每日工作台账与原看板 |
| Agent Home / ppeng-agent-bot | 调用已有房间、Bot 工单与消息接口；协调器直接使用 `@ppeng/agent-loop` | Bot 身份、会话、模型和工具执行 |
| Herdr | 以工作流运行号定位终端、pane 和隔离工作树 | 工程执行现场 |
| ChromeGate Gateway | 店铺实验引用原仓的场景文件、预检命令和版本 | 浏览器工具、场景运行和原始回执 |

| 从哪里进 | 你会看到什么 | 下一步 |
| --- | --- | --- |
| 项目目录 → 维护仓库 → 开源能力 | 这个仓库提供什么、由哪个项目维护、哪个提交或标签有这个接口 | 打开原始凭据核对，选定使用方，登记用途 |
| 研发选题 → 候选 → 查找已有能力 | 候选想解决的问题、可选的原仓接口、已有决定 | 能用就锁定版本。需要工程集成时，只在使用方做调用和集成测试 |
| Zoom → 待我处理 → 原仓维护需求 | 哪个项目需要、影响范围、涉及的现有版本、要怎样验收 | 批准该版、要求修改或拒绝。反馈回原需求，批准后工作归维护方 |

**仓库搜索先于立项。** 先用本地目录看已核实的接口，再用 GitHub 自己的搜索查账号下其他开源项目的名称、说明与 README。找到相关项目后，核对具体提交里的接口或运行样例，再登记这个版本。登记提交号时，凭据链接应包含对应的 SHA。登记发布标签时，选同一标签的 Release 页面或该标签下的接口文档。搜索结果是一条待核实的线索。没有搜到时，记录查过的项目和关键词，在需求里说明还缺哪段行为。

```sh
npm run opc -- capability discover chromegate --owner magele758
npm run opc -- project sync magele758/chromegate-gateway --product ChromeGate
npm run opc -- capability import --verified --repo magele758/chromegate-gateway
npm run opc -- capability list --repo magele758/chromegate-gateway
```

**以店铺实验为例。** 草稿检查项目想在实验前检查场景文件。ChromeGate Gateway 已提供 `verify --dry-run`。在原仓固定提交运行 `node native/cli.mjs verify scenarios/identity.json --dry-run`，得到样例名、动作列表及断言。使用方保存提交和入口，店铺观察归各自实验。如需按实验编号关联回执，可以作为一份待核实的原仓需求，写清「两个实验共用一个场景，返回结果仍能分别定位」这个验收办法。[原仓实现](https://github.com/magele758/chromegate-gateway/blob/de40180a00fc6e035709b8f3223347fd7b0d28de/native/cli.mjs) · [实际预检输出](../../data/opc-validation/gateway-preflight.json)

**批准需求与批准工程计划分两次。** 你先在本机 Zoom 决定是否将这一版需求交给维护项目。Coding agent 可以提交需求、修订和读取回执。维护方绑定本地 Git 工作区并腾出在途名额后，OPC OS 起草工程计划。你在另一张计划卡确认执行者与版本后才派发。未绑定工作树时，获批需求留在维护项目候选中。退回或拒绝后，采用方可修订缺口再送审，也可以写明愿意接受的限制，改用现有版本。两种决定都能追到最初的需求和反馈。

维护方交付后，从原消费候选选择经过验证的固定版本，勾选它实际解决的那份已批缺口，填写复测场景与结果，并核对该版本的原仓交付链接。这次确认记下操作者和时间。已经登记为普通采用的版本也可补填这一项，原用途仍可回查。比如修复落在维护分支的 `v1.9.4`，而需求原先绑定 `v2.0.0`，采用方可以根据回移版本的测试结果与发布凭据选它。登记顺序、版本号和本地工作区都不决定这项验收。

**维护 agent 可以从自己的会话接手。** 在已连接本机 OPC OS 的环境里运行 `opc-os capability requests --repo magele758/chromegate-gateway` 查看该仓库的请求，再用 `opc-os capability show <需求ID>` 取回原话、批准版本与关联计划。可以从 Zoom 跳到同一份需求，查看是谁提出的、谁在等回复。

六个首批引用来自 ChromeGate Gateway、PageLens Agent、PageLens Interpret、audiobook、learn-agent 和 ppeng-agent-bot。导入按公司目录里的仓库归属登记，未关联的会列出供核对。新的开源库可持续按相同方式接入。[固定版本与原仓出处](../../examples/repository-capabilities.json) · [可点击的协作流程](flows.html#reuse)
