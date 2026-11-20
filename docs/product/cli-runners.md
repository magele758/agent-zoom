# 用本机 coding agent 执行计划

启动服务前，在工作流配置里选择实现和独立评审的默认执行者。把计划节点的可选实现者登记到 `capabilities`，审批前就能在 Zoom「查看计划」里选择。换人会产生一个新计划版本。

下面以使用 Node 内建测试的项目为例。把示例中的工作树路径与适配器路径换成实际绝对路径。测试命令和每个参数分别占一项，直接交给进程执行。

```json
{
  "backend": "herdr",
  "workspace": "/path/to/project",
  "projectWorkspaces": { "owner/project": "/path/to/project" },
  "implement": ["node", "/path/to/opc-os/scripts/workflow-cli-agent.mjs", "cursor-agent", "implement", "node", "--test"],
  "review": ["node", "/path/to/opc-os/scripts/workflow-codex.mjs", "review", "node", "--test"],
  "capabilities": {
    "grok": ["node", "/path/to/opc-os/scripts/workflow-cli-agent.mjs", "grok", "implement", "node", "--test"],
    "agy": ["node", "/path/to/opc-os/scripts/workflow-cli-agent.mjs", "agy", "implement", "node", "--test"],
    "cursor-agent": ["node", "/path/to/opc-os/scripts/workflow-cli-agent.mjs", "cursor-agent", "implement", "node", "--test"]
  }
}
```

每个节点在 Herdr 给它的独立工作树中启动一个新 CLI 进程。适配器传入当前目标、节点边界、上游检查和返工意见，随后单独运行预设的项目测试。每次尝试目录保留任务输入、CLI 回答、诊断、测试原始输出和回执。模型未给出明确结论、进程报错或项目检查失败都会返回失败。Grok 和 Cursor 可沿用 CLI 配置。agy 独立进程未指定模型时，从本账户的可用列表选择 Flash Medium、其他 Medium 或第一项，并在回执里记录模型 ID。可以在角色参数后通过 `"--model", "模型ID"` 固定模型，也可在 CLI 实际运行的环境中设置 `OPC_GROK_MODEL`、`OPC_AGY_MODEL` 或 `OPC_CURSOR_MODEL`。独立的 Herdr 后台会话可沿用服务端的本机回环代理。仓库测试使用自己的运行环境。

独立评审可以使用 Codex 的 `read-only` 或 Cursor 的 `ask` 模式。例如把 `review` 设为 `["node", "/path/to/opc-os/scripts/workflow-cli-agent.mjs", "cursor-agent", "review", "node", "--test"]`。评审者在独立工作树中检查上游已组装的改动，公共工作器也会核对评审阶段是否留下额外差异。Grok 与 Antigravity 在本适配器中用于实现。

可以用 `node --test scripts/workflow-cli-agent.test.mjs` 检查参数、角色限制和失败回执。用 `npm run build && node --import tsx scripts/opc-room-demo.mjs --browser` 验证项目讨论室；这条命令需要本机已有编译好的 Agent Home，可在末尾传入对应检出目录。

## 在临时仓库演示

执行 `npm run opc:demo -- --herdr --agy`。它创建临时 Git 仓库，由测试操作者批准计划，Antigravity 实现，Cursor Agent 独立评审，然后在控制台打印证据文件路径。把 `--agy` 换成 `--grok` 可以采用 Grok 实现，换成 `--cursor-agent` 可以采用 Cursor 实现与 Codex 评审。加上 `--interactive` 会打印看板地址并等待你亲自批准。
