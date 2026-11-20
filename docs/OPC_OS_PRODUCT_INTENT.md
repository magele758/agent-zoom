# OPC OS产品设计

产品导读 · 2026 年 11 月 20 日

这份设计把OPC OS作为一人公司管理多个产品的总入口。你照常在 **daily-review-learning** 读当天的材料，选一条启发，交给现有项目或从它新建项目。任意 coding agent 都能发起工作，项目房间可接入 Agent Home 的 Bot，OPC OS保存计划、审批、证据和回执，Herdr 承载工程执行。发布后的采用情况、经营结果和可复用的成果回到原想法。

**平时从公司总览找机会，忙时只看 Zoom 的「待我处理」。** 两个入口通向同一项工作，答复跟着原问题回到对应的人或会话。

[首次启动与试用](product/start.md)　·　[看多业务线流转](product/flows.html#lines)　·　[打开交互流程图](product/flows.html#business)　·　[看页面跳转](product/flows.html#navigation)　·　[看审批与返工](product/flows.html#execution)　·　[看 Agent Hub 联动](product/flows.html#hub)

公司可经营多条业务线，研发和探索中的店铺运营可以共用项目与插件。[业务线与自动选题设计](product/operating-model.md) · [界面设计稿](product/opc-workbench.html)

## 按你关心的问题阅读

| 你想看什么 | 打开哪一份 |
| --- | --- |
| 全公司 7 层架构怎么分层？供给侧与商业变现、数据分析怎样串成闭环？ | [AI-Native OPC 7 层蓝图与职责边界](product/opc-7-layer-blueprint.md) |
| 哪些项目在等安全复核，哪些服务要更新，派任务前怎样查套餐余量？ | [安全、运维和资源成本部门](product/company.md#公司部门) |
| 我的开源项目已有这项能力，谁来接入？需要扩展时由谁改？ | [复用原仓、提需求与审批](product/reuse.md) · [交接图](product/flows.html#reuse) |
| <a id="knowledge-to-business"></a>信息、想法、产品、项目怎么组织？二月的工厂构想怎么接进来？ | [公司目录与跨项目复用](product/company.md#knowledge-to-business) |
| <a id="work-flow"></a>一条启发怎样变成可用的特性？发布后怎样判断是否继续？ | [业务流程与各阶段交付](product/lifecycle.md) |
| <a id="page-flow"></a>从哪个页面进入，点下去看什么，处理完回到哪？ | [页面跳转与消息处理](product/navigation.md) |
| <a id="room-bots"></a>谁发起、谁执行？Bot 怎么接话？失败后怎样回到原任务？ | [执行分工与房间协作](product/execution.md#room-bots) |
| 哪些真跑过 Herdr，哪些是模拟？还有什么要验证？ | [验证记录、试点与待定事项](product/verification.md) |

个人每天做了什么，可以照常在 Agent Hub 的工作看板查看。OPC OS 可按指定日期引用工作条目，在项目复盘里核对投入。[本机工作看板](http://127.0.0.1:28790/#secBoard)

图中使用 PageLens 作为设计示例。已运行的工程验收、尚待联调的房间 Bot，以及仍在讨论的业务流程，分别列在验证记录里。
