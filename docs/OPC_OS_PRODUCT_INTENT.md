# OPC OS产品设计

产品导读 · 2026 年 11 月 21 日

这份设计把 OPC OS 作为一人公司（OPC）的 7 层操作系统总入口。你照常在 **daily-review-learning** 读当天的材料，选一条启发，交给现有项目或从它新建项目；任意 coding agent 都能发起工作，项目讨论室可接入 Agent Home 的 Bot，OPC OS 保存计划、审批、证据和回执，Herdr 承载隔离工作树与独立评审；在商业侧，**商业与治理部**串联 6 大伴生服务（收银离线授权、GTM 门面合规、客服工单遥测与 DuckDB 漏斗分析），让 1 号变现试点与多条业务线跑通真实闭环。

**平时从全局看板或组织数字孪生找机会，忙时只看 Zoom 的「待我处理」。** 入口全部指向同一份项目、业务线与任务记录，答复跟着原问题回到对应的人或会话。

[首次启动与一键全栈](product/start.md)　·　[7 层架构蓝图](product/opc-7-layer-blueprint.md)　·　[界面设计稿（全能力原型）](product/opc-workbench.html)　·　[多业务线流转](product/flows.html#lines)　·　[商业闭环图](product/flows.html#commercial)　·　[业务流程图](product/flows.html#business)　·　[页面跳转](product/flows.html#navigation)　·　[全站委派](product/flows.html#delegation)　·　[审批与返工](product/flows.html#execution)　·　[Agent Hub 联动](product/flows.html#hub)

公司通过 5 套标准化业务线打法库同时经营供给研发、旗舰插件变现（1 号试点）、Open-Core、店铺运营与轻工具流量漏斗，并由**组织数字孪生**（3 透镜 + 35 个直达锚点）一屏透视全公司运行状态。[业务线与自动选题设计](product/operating-model.md) · [组织数字孪生设计稿](product/opc-workbench.html#digital-twin)

## 按你关心的问题阅读

| 你想看什么 | 打开哪一份 |
| --- | --- |
| 全公司 7 层架构怎么分层？供给侧与商业变现、离线授权、DuckDB 漏斗怎样串成闭环？ | [AI-Native OPC 7 层蓝图与职责边界](product/opc-7-layer-blueprint.md) · [商业闭环图](product/flows.html#commercial) |
| 全站有哪些页面与功能？如何通过组织数字孪生一屏直达 22 个功能舱室与 13 阶工作单？ | [界面设计稿（全能力原型）](product/opc-workbench.html) · [页面跳转与导航结构](product/navigation.md) |
| 商业治理、安全复核、服务健康探针与模型套餐余量分别在哪管？ | [公司四部（商业/安全/运维/资源成本）](product/company.md#公司部门) |
| 我的开源项目已有这项能力，谁来接入？需要扩展时由谁改？ | [复用原仓、提需求与审批](product/reuse.md) · [交接图](product/flows.html#reuse) |
| <a id="knowledge-to-business"></a>信息、想法、产品、项目怎么组织？二月的工厂构想怎么接进来？ | [公司目录与跨项目复用](product/company.md#knowledge-to-business) |
| <a id="work-flow"></a>一条启发怎样变成可用的特性？发布后怎样判断是否继续？ | [业务流程与各阶段交付](product/lifecycle.md) |
| <a id="page-flow"></a>从哪个页面进入，点下去看什么，处理完回到哪？ | [页面跳转与消息处理](product/navigation.md) |
| <a id="room-bots"></a>谁发起、谁执行？Bot 怎么接话？失败后怎样回到原任务？ | [执行分工与房间协作](product/execution.md#room-bots) |
| 哪些真跑过 Herdr 与商业闭环自检，哪些是模拟？还有什么要验证？ | [验证记录、试点与待定事项](product/verification.md) |

个人每天做了什么，可以照常在 Agent Hub 的工作看板查看。OPC OS 可按指定日期引用工作条目，在项目复盘里核对投入。[本机工作看板](http://127.0.0.1:28790/#secBoard)

图中以 PageLens（1 号商业试点）与 ChromeGate Gateway 等真实仓库作为设计示例。已运行的工程验收、商业闭环自检、项目讨论室联调与待定事项，分别列在验证记录里。
