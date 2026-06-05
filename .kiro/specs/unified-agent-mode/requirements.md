# 需求文档

## 简介

将 NoTerm 桌面应用中的 AI 助手从当前的"聊天/Agent 双模式 + 预先规划"架构，重构为统一的单步执行 Agent 模式。新架构采用"思考→行动→观察"循环，AI 逐步执行命令并根据实时结果决定下一步操作，类似 Codex Desktop 和 Claude Code Desktop 的交互体验。

## 术语表

- **Agent_Loop**: 统一的 AI 执行循环引擎，负责协调"思考→行动→观察"的迭代过程
- **Step**: Agent 循环中的一个迭代单元，包含一次思考（thinking）和可选的一次动作（action）
- **Thinking_Block**: AI 的推理过程文本块，以流式方式实时展示给用户
- **Action_Block**: AI 决定执行的 shell 命令块，包含命令内容、风险等级和执行状态
- **Output_Block**: 命令执行后的输出结果块，包含 stdout、stderr 和退出码
- **Policy_Engine**: 安全策略引擎，评估命令风险等级并决定是否需要用户确认
- **Audit_Logger**: 审计日志记录器，记录所有 Agent 事件并对敏感信息进行脱敏
- **Stream_Renderer**: 流式渲染器，负责将 Agent 循环的各类块实时渲染到 UI 中
- **Risk_Level**: 命令风险等级，分为 low（低）、medium（中）、high（高）、critical（严重）

## 需求

### 需求 1：统一 Agent 模式

**用户故事：** 作为用户，我希望 AI 助手始终以 Agent 模式运行，无需手动切换模式，从而简化交互流程。

#### 验收标准

1. THE Agent_Loop SHALL operate as the sole interaction mode for the AI assistant
2. WHEN the application starts, THE Agent_Loop SHALL be active without requiring user mode selection
3. WHEN the user sends a message, THE Agent_Loop SHALL process it through the think-act-observe cycle
4. THE Settings_Page SHALL NOT display any agent mode toggle or selection controls

### 需求 2：逐步执行循环

**用户故事：** 作为用户，我希望 AI 根据每一步的执行结果来决定下一步操作，而不是预先生成完整计划，从而获得更准确和自适应的执行结果。

#### 验收标准

1. WHEN the user submits a request, THE Agent_Loop SHALL generate a single thinking response before deciding on an action
2. WHEN the Agent_Loop decides to execute a command, THE Agent_Loop SHALL execute only one command per step
3. WHEN a command execution completes, THE Agent_Loop SHALL feed the command output back to the AI for the next decision
4. WHEN the AI determines the task is complete, THE Agent_Loop SHALL produce a final summary response without further actions
5. WHEN the AI determines no shell command is needed, THE Agent_Loop SHALL respond with only a thinking block containing the answer
6. IF the Agent_Loop encounters an execution error, THEN THE Agent_Loop SHALL include the error details in the next AI prompt for self-correction

### 需求 3：流式实时展示

**用户故事：** 作为用户，我希望实时看到 AI 的思考过程和命令执行结果，从而了解 Agent 的工作进展。

#### 验收标准

1. WHEN the AI generates thinking content, THE Stream_Renderer SHALL display it incrementally as tokens arrive
2. WHEN the Agent_Loop decides to execute a command, THE Stream_Renderer SHALL display the Action_Block with command text and risk level before execution begins
3. WHILE a command is executing, THE Stream_Renderer SHALL display a running status indicator on the Action_Block
4. WHEN a command completes, THE Stream_Renderer SHALL display the Output_Block with stdout, stderr, and exit code
5. THE Stream_Renderer SHALL render all blocks in chronological order as a linear conversation stream
6. WHEN the user scrolls up during streaming, THE Stream_Renderer SHALL pause auto-scroll and provide a button to resume following

### 需求 4：基于风险的命令确认

**用户故事：** 作为用户，我希望低风险命令自动执行而高风险命令需要我确认，从而在效率和安全之间取得平衡。

#### 验收标准

1. WHEN the Policy_Engine evaluates a command as low risk, THE Agent_Loop SHALL execute the command automatically without user confirmation
2. WHEN the Policy_Engine evaluates a command as medium risk with unknown command type, THE Agent_Loop SHALL pause and request user confirmation before execution
3. WHEN the Policy_Engine evaluates a command as high or critical risk, THE Agent_Loop SHALL pause and display a prominent confirmation dialog with risk details
4. WHEN the Policy_Engine blocks a command, THE Agent_Loop SHALL skip execution and feed the block reason back to the AI
5. WHEN the user rejects a pending command, THE Agent_Loop SHALL skip the command and inform the AI of the rejection
6. WHEN the user confirms a pending command, THE Agent_Loop SHALL proceed with execution immediately
7. IF the user does not respond to a confirmation request within 5 minutes, THEN THE Agent_Loop SHALL cancel the pending action and inform the AI of the timeout

### 需求 5：安全审计保留

**用户故事：** 作为系统管理员，我希望所有 Agent 执行事件都被记录和审计，从而追踪操作历史和排查问题。

#### 验收标准

1. WHEN the Agent_Loop executes a command, THE Audit_Logger SHALL record the command, risk level, session ID, and execution result
2. WHEN the Agent_Loop starts a new session, THE Audit_Logger SHALL record the session start event with the user request
3. WHEN the Policy_Engine blocks a command, THE Audit_Logger SHALL record the block event with the reason
4. THE Audit_Logger SHALL redact sensitive information including passwords, API keys, and private keys from all log entries
5. THE Audit_Logger SHALL maintain a maximum of 500 audit records with oldest records being removed first

### 需求 6：AI API 适配

**用户故事：** 作为用户，我希望新的 Agent 模式能兼容现有的 AI 提供商（OpenAI 兼容和 Anthropic），从而无需更换 AI 服务。

#### 验收标准

1. THE Agent_Loop SHALL support OpenAI-compatible API providers with streaming responses
2. THE Agent_Loop SHALL support Anthropic API with streaming responses
3. WHEN sending a request to the AI, THE Agent_Loop SHALL include the conversation history with previous steps' thinking, actions, and outputs
4. WHEN sending a request to the AI, THE Agent_Loop SHALL include a system prompt instructing the AI to respond in a structured format with thinking and optional action
5. THE Agent_Loop SHALL parse the AI response to extract thinking content and optional command action with risk assessment

### 需求 7：会话管理

**用户故事：** 作为用户，我希望能够中断正在执行的 Agent 循环并开始新的对话，从而保持对 AI 助手的控制。

#### 验收标准

1. WHEN the user clicks the stop button during Agent execution, THE Agent_Loop SHALL abort the current operation and stop the loop
2. WHEN the user sends a new message while the Agent is idle, THE Agent_Loop SHALL start a new execution cycle
3. WHEN a command is currently executing and the user requests stop, THE Agent_Loop SHALL attempt to terminate the running command
4. WHEN the Agent_Loop is stopped, THE Stream_Renderer SHALL display a clear indication that execution was interrupted

### 需求 8：旧架构清理

**用户故事：** 作为开发者，我希望移除所有旧的双模式和预先规划相关代码，从而保持代码库的整洁和可维护性。

#### 验收标准

1. WHEN the refactoring is complete, THE codebase SHALL NOT contain any references to the "suggest_only" or "confirm_then_execute" mode types
2. WHEN the refactoring is complete, THE codebase SHALL NOT contain the AgentPlan, AgentPlanRuntime, or AgentPlanParseResult type definitions
3. WHEN the refactoring is complete, THE codebase SHALL NOT contain the plan parsing logic (parseAgentPlanFromText and related functions)
4. WHEN the refactoring is complete, THE Settings store SHALL NOT contain the "ai.agentMode" configuration key
5. WHEN the refactoring is complete, THE UI SHALL NOT contain mode toggle buttons or plan confirmation card components
