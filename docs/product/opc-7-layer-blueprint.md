# AI-Native OPC（一人公司）7 层操作系统蓝图与职责边界

这份架构卡定义了本公司全部代码资产在 **供给侧（造产品 + 跑 Agent）**、**需求与资金侧（获客 + 收银授权 + 客服遥测）** 与 **分析决策侧（经营本体 + 漏斗毛利复盘）** 的统一分层、职责边界和两条核心业务闭环。[返回产品导读](../OPC_OS_PRODUCT_INTENT.md) · [商业闭环流程图](flows.html#commercial) · [界面设计稿](opc-workbench.html#commercial) · [打开商业与公司治理台](/#commercial)

---

## 一、7 层全景地图（L0 – L6）

```text
═══════════════════════════════════════════════════════════════════════════════
                      AI-Native OPC（一人公司）7 层操作系统蓝图
═══════════════════════════════════════════════════════════════════════════════

L6 · 对外产品矩阵（货架 / 变现载体）
     ├─ 旗舰付费（1号试点）：pagelens-interpret（视频实时同传与中文配音扩展）
     ├─ 旗舰 / Prosumer：pagelens-agent（网页理解侧栏）/ audiobook（Index-TTS 有声书）
     ├─ 开发者 Open-Core：hyper-vibekanban / ppeng-agent-bot / data_analysis
     └─ 免费流量钩子（Lead Magnet）：Rubiks-Cube-Learn / bazi-ziwei-learning / godot-game-*
          ▲
L5 · 商业化与客户运营平面（GTM / Billing / License / Support / Telemetry）
     ├─ opc-commerce-kit：MoR 支付 Webhook + Ed25519 离线 License 签发验签 + FinOps 毛利台账
     ├─ opc-gtm-kit：高转化产品着陆页 + 商店隐私合规底板 + UTM 归因 + Waitlist + 多平台改编
     ├─ opc-ops-kit：统一客服工单分诊（联动研发选题与 Zoom 审批）+ 隐私优先遥测与崩溃指纹
     └─ 分发工作台：cose（多平台图文同步）+ magele758.github.io（品牌与产品矩阵门户）
          ▲
L4 · 经营分析与业务本体层（CFO + 数据总监）
     └─ data_analysis：DuckDB + Arrow + Palantir Ontology/Actions + 漏斗/留存/RFM + Reverse ETL
          ▲
L3 · 外部执行手脚与确定性验收层（受控 Actuator & QA）
     ├─ chromegate-gateway：按 Agent 发 cgk_ 最小权限令牌 + 发布/付款人工确认弹窗 + 无模型 verify
     └─ chromegate：内部重度网页采集、剪藏与发布工作台
          ▲
L2 · 公司中枢与产研协作控制面（OPC 总控 + 工程工厂）
     ├─ agent-zoom（OPC OS）：全局看板、组织数字孪生（35 锚点全息沙盘）、业务线、公司四部、13 阶段进程、跨 Agent Zoom 审批与商业联动
     ├─ hyper-vibekanban：异步 Issue 看板、Squad DAG 与 Git Worktree 并行编码交付流水线
     └─ agent-term：Founder 原生终端驾驶舱与本地高危操作物理审批兜底
          ▲
L1 · 常驻数字员工内核与认知飞轮（Agent OS + 知识资产）
     ├─ ppeng-agent-bot：7×24 Goal Ledger、Routines 巡检、IM 房间交互与可嵌入 agent-loop 内核
     └─ 情报与主动学习：daily-review-learning / github-trending-archive / learn-agent
          ▲
L0 · 单机统一数据底座（Storage Substrate）
     └─ strata：Rust 单机事务 + BM25 全文 + HNSW 向量 + 列存副本
═══════════════════════════════════════════════════════════════════════════════
```

---

## 二、核心重叠域的职责边界（互不越界）

### 1. 四大 Agent 控制面分工

| 仓库 | 公司角色 | 核心职责（管什么） | 明确边界（不管什么） |
| :--- | :--- | :--- | :--- |
| **`agent-zoom`（OPC OS）** | **CEO/COO 经营总控台 & 评审中枢** | 公司多业务线治理、7 层项目档案、13 阶段交付证据、跨 Agent 待决问题收件箱（Zoom）、商业与分析服务总串联 | 不直接替工程仓库合并代码，不保存第三方平台私钥 |
| **`ppeng-agent-bot`** | **常驻数字员工 OS** | 7×24 长期目标账本、定时巡检 Routines、飞书/IM 房间 Bot 交互、提供 `@ppeng/agent-loop` 内核 | 不替代多仓库 Git Worktree 重型编码流水线 |
| **`hyper-vibekanban`** | **软件工程交付工厂** | Issue 看板自动入队、Squad DAG 并行编码、Worktree 隔离、PR 交付与手机远程触发 | 不承载公司级财务对账、商业授权与跨产品经营复盘 |
| **`agent-term`** | **Founder 个人终端驾驶舱** | 本地高危排障、需要人工逐条确认的本机命令直操 | 不做后台无人值守业务编排 |

### 2. 浏览器系仓库的“对内基建 vs 对外商品”切分

- **对内基础设施（不直接售卖）**：
  - `chromegate-gateway`：全公司唯一受控浏览器执行与确定性 E2E 验收网关（`verify` + 发布/付款强制人工弹窗确认）。
  - `cose` + `chromegate`：配合 `opc-gtm-kit` 完成一鱼多吃内容同步与网页素材采集。
- **对外商业产品（直接面向用户变现）**：
  - `pagelens-interpret`（1 号商业试点：视频实时同传 + 中文配音，离线 License 解锁 Pro）
  - `pagelens-agent`（BYOK 网页理解与填表侧栏，Open-Core / Pro 授权）
- **历史演进母体（归档收口，避免外部访客分流）**：
  - `open-chrome-ai`、`translate-any-video`、`chrome-ollama-translator` 指向新一代独立扩展，不再并行铺摊子。

---

## 三、两条核心运转闭环

### 闭环 A：产品研发与确定性交付链（供给侧）
1. **线索汇入**：`daily-review-learning` 启发、GitHub Issue 或 `opc-ops-kit` 升级的用户缺陷工单进入 OPC OS。
2. **选题与审批**：OPC OS 按「影响 × 把握 ÷ 工作量」生成候选，经 Zoom 批准计划后交由 Herdr / `hyper-vibekanban` 在隔离工作树实现与独立评审。
3. **发布门禁**：通过项目自动化测试与 `chromegate-gateway verify` 确定性回放后，由人工在 Zoom 放行发布，并由 `opc-ops-kit` 生成提单用户回访通知。

### 闭环 B：获客 → 授权变现 → 经营分析复盘链（商业侧）
1. **门面与获客（`opc-gtm-kit`）**：从产品清单一键生成高转化着陆页、Chrome 商店隐私合规声明与 5 渠道带参（UTM）推广稿；访客点击或加入 Waitlist 自动向 OPC OS 记入 `acquired` 事件。
2. **激活与客服（`opc-ops-kit`）**：客户端匿名上报首次核心价值动作（自动向 OPC OS 记入 `activated` 事件）与去隐私崩溃指纹；用户反馈自动按 FAQ 答复、转研发选题或升级 Zoom 退款审批。
3. **收银与离线授权（`opc-commerce-kit`）**：接收 Lemon Squeezy / Paddle / Creem 订单 Webhook，自动签发 **Ed25519 离线可验 `OPCL1` License Key**，向 OPC OS 记入 `order` 事件与业务线收款凭据，并扣除 LLM Token / 基础设施成本算出真实净毛利。
4. **本体与漏斗复盘（`data_analysis` ↔ `OPC OS`）**：全链路事件以标准 17 列 Trace 导入 `data_analysis` 的 DuckDB 会话，执行多步转化漏斗、留存与异动洞察，结果回写 OPC OS 驾驶舱指导下一轮业务线决策。

---

## 四、组合聚焦铁律（Portfolio Governance）

1. **同一时期只指定 1 个「1 号变现试点」**：在跑通「门面 → 获客 → 激活 → 收款发码 → 客服 → `data_analysis` 复盘」全闭环前，冻结新建底层基础设施仓库。
2. **薄胶水 + 强契约**：收银税务交由 MoR 托管，客户端坚持本地优先与 Ed25519 离线验签，所有经营事实统一沉淀回本机 SQLite 与 DuckDB。

---

## 五、一键拉起与闭环自检

```sh
npm run opc:up                 # 启动 OPC OS + 自动拉起 Commerce(:52331) / GTM(:52332) / Ops(:52333) / data_analysis(:8000) 并纳管 18 项 7 层资产
npm run opc:stack -- status    # 查看 6 大服务健康度、1 号商业试点就绪度与核心指标
npm run opc:verify             # 端到端自检：UTM 获客 -> 激活 -> 订单与 Ed25519 离线 License -> DuckDB 漏斗同步
npm run opc:stack -- stop      # 停止由 stack 自动拉起的附属伴生服务
```

命令行亦支持 `opc-os commercial overview|bootstrap|ensure|closed-loop|sync-analytics|playbook <模板ID>`，或在浏览器打开 `/#commercial`（商业与治理部）与 `/#digital-twin`（组织数字孪生）直接操作。[首次启动与命令说明](start.md)
