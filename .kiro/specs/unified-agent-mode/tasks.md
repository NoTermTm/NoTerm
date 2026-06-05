# Implementation Plan: 统一 Agent 模式

## 概述

将 NoTerm AI 助手从双模式+预先规划架构重构为统一的单步执行 Agent 模式。实现按照"类型定义→核心引擎→UI 组件→集成→清理"的顺序推进，确保每一步都可增量验证。

## Tasks

- [x] 1. 重构类型定义
  - [x] 1.1 重构 `src/types/agent.ts`，移除旧类型并新增 Agent Loop 类型
    - 移除 `AgentMode`, `AgentPlan`, `AgentPlanRuntime`, `AgentPlanParseResult`, `AgentPlanStatus`, `AgentPlanActivityTone`, `AgentActionRuntime`
    - 保留 `AgentRisk`, `AgentPolicyStatus`, `AgentPolicyDecision`, `AgentCommandResult`
    - 新增 `AgentStepAction`, `AgentStep`, `AgentSession`, `AgentBlock`, `AgentBlockType`
    - 更新 `AgentActionStatus` 为新的状态集合（pending/confirmed/running/success/failed/blocked/rejected/timeout）
    - _Requirements: 8.2, 2.2_

- [x] 2. 实现响应解析器
  - [x] 2.1 创建 `src/terminal/agentResponseParser.ts`
    - 实现 `parseAgentResponse(rawText: string): ParsedAgentResponse` 函数
    - 解析 `<thinking>...</thinking>` 标签提取思考内容
    - 解析 `<action>{"command": "...", "risk": "...", "reason": "..."}</action>` 标签提取动作
    - 解析 `<done/>` 标签识别循环结束信号
    - 实现 `extractStreamingThinking(partialText: string): string` 用于流式解析
    - _Requirements: 6.5, 2.2, 2.5_

  - [ ]* 2.2 编写响应解析器的属性测试
    - **Property 1: 响应解析结构完整性**
    - **Validates: Requirements 2.2, 2.5, 6.5**
    - 使用 fast-check 生成随机结构化响应，验证解析正确性
    - 测试 thinking-only、thinking+action、thinking+done 三种模式

- [x] 3. 适配策略引擎
  - [x] 3.1 更新 `src/terminal/agentPolicy.ts` 接口
    - 将 `evaluateAgentActionPolicy` 的输入参数从 `AgentAction` 改为 `PolicyEvaluationInput`（仅需 command, risk, session_id）
    - 保持内部评估逻辑不变（READ_ONLY_PREFIXES, MEDIUM_PREFIXES, HIGH_PREFIXES, BLOCKED_PATTERNS）
    - 导出新的 `evaluateCommandPolicy` 函数名
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 3.2 编写策略引擎的属性测试
    - **Property 3: 策略评估决定执行行为**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
    - 使用 fast-check 生成随机命令，验证风险分类正确性

- [x] 4. 适配审计日志
  - [x] 4.1 更新 `src/terminal/agentAudit.ts`
    - 移除对 `AgentMode` 和 `AgentPlan` 类型的依赖
    - 更新 `AgentAuditEvent` 为新事件类型（loop_started, step_thinking, step_action_decided, step_action_confirmed, step_action_rejected, step_action_executed, step_action_blocked, loop_completed, loop_stopped, loop_error）
    - 更新 `AgentAuditRecord` 接口，移除 mode 和 plan 字段，新增 step_index 字段
    - 保持 `redactSensitiveText` 和容量限制逻辑不变
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 4.2 编写审计日志的属性测试
    - **Property 4: 审计记录完整性**
    - **Property 5: 敏感信息脱敏**
    - **Property 6: 审计日志容量上限**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**

- [x] 5. Checkpoint - 确保基础模块测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. 实现 Agent Loop 引擎
  - [x] 6.1 创建 `src/terminal/agentLoop.ts`
    - 实现 `createAgentLoop(config: AgentLoopConfig): AgentLoopController`
    - 实现核心循环：调用 AI → 解析响应 → 评估策略 → 执行/确认/阻止 → 反馈结果 → 重复
    - 实现对话历史构建逻辑（system prompt + user request + 历史步骤）
    - 实现 stop() 方法：中止当前 AI 请求或命令执行
    - 实现 confirmAction/rejectAction 方法：处理用户确认/拒绝
    - 实现 5 分钟确认超时逻辑
    - 集成审计日志记录
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 7.1, 7.2, 7.3_

  - [x] 6.2 创建 Agent 系统提示构建函数
    - 在 `agentLoop.ts` 中实现 `buildAgentSystemPrompt(terminalContext: string, locale: string): string`
    - 指示 AI 使用 `<thinking>`, `<action>`, `<done/>` 格式响应
    - 包含终端上下文信息
    - 支持中英文双语
    - _Requirements: 6.4_

  - [ ]* 6.3 编写 Agent Loop 的属性测试
    - **Property 2: 对话历史完整性**
    - **Property 7: 每步最多一个动作（不变量）**
    - **Property 10: 阻止原因反馈**
    - **Validates: Requirements 2.2, 2.3, 2.6, 4.4, 6.3**
    - 使用 mock AI 和 mock 命令执行器测试循环逻辑

- [x] 7. 实现流式渲染组件
  - [x] 7.1 创建 `src/components/AgentStreamView.tsx`
    - 实现 AgentBlock 列表渲染（thinking/action/output/error/done 类型）
    - Thinking 块：渲染 markdown 格式的思考内容
    - Action 块：显示命令文本、风险等级标签、执行状态指示器
    - Output 块：显示 stdout/stderr（带语法高亮）和退出码
    - 实现确认 UI：当 pendingConfirmation 不为 null 时显示确认/拒绝按钮
    - 实现自动滚动逻辑：新块到达时自动滚动到底部，用户上滚时暂停并显示"回到底部"按钮
    - 实现停止按钮
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.3, 4.5, 4.6, 7.4_

  - [x] 7.2 创建 `src/components/AgentStreamView.css`
    - 样式设计与现有 AI 面板风格一致
    - Thinking 块：浅色背景，等宽字体
    - Action 块：带边框，风险等级颜色编码（low=绿, medium=黄, high=红）
    - Output 块：深色背景，终端风格
    - 确认对话框：突出显示，带风险警告色
    - _Requirements: 3.2, 3.3, 3.4, 4.3_

  - [ ]* 7.3 编写渲染块的属性测试
    - **Property 8: 渲染块信息完整性**
    - **Property 9: 渲染块时序有序性**
    - **Validates: Requirements 3.2, 3.4, 3.5**

- [x] 8. Checkpoint - 确保新组件测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. 集成到 XTerminal
  - [x] 9.1 重构 `src/components/XTerminal.tsx` 中的 AI 面板
    - 移除 `agentMode` 状态和 `handleAgentModeChange` 函数
    - 移除 `buildAgentSystemPrompt`（旧的 JSON 计划版本）和 `buildAgentDecisionSystemPrompt`
    - 移除 `buildAgentPlanRuntime`、`toRuntimeActions` 等计划相关函数
    - 移除计划执行相关的 refs（planStopRequestedRef, planExecutionLockRef）
    - 引入 `createAgentLoop` 并在 AI 面板中使用
    - 将 `handleAiSend` 改为始终通过 Agent Loop 处理
    - 用 `AgentStreamView` 替代旧的消息列表和计划卡片 UI
    - _Requirements: 1.1, 1.2, 1.3, 7.1, 7.2, 7.3_

  - [x] 9.2 移除 UI 中的模式切换按钮
    - 删除 `xterminal-agent-mode-btn` 相关的 JSX 和样式
    - 删除 agent mode 相关的 CSS 类
    - _Requirements: 1.4, 8.5_

- [x] 10. 更新设置和存储
  - [x] 10.1 更新 `src/store/appSettings.ts`
    - 从 `AppSettings` 类型中移除 `"ai.agentMode"` 字段
    - 从 `DEFAULT_APP_SETTINGS` 中移除对应默认值
    - _Requirements: 8.4_

  - [x] 10.2 更新 `src/pages/Settings.tsx`
    - 移除 AI 设置区域中的 agent mode 选择控件
    - 移除读取/写入 `ai.agentMode` 的逻辑
    - _Requirements: 1.4, 8.4_

  - [x] 10.3 更新 `src/api/ai.ts`
    - 从 `AiSettings` 类型中移除 `agentMode` 字段
    - 移除 `parseAgentPlanFromText` 函数及相关辅助函数（extractJsonCandidate, normalizeAction, normalizePlan）
    - 保留 `sendAiChat` 和 `sendAiChatStream` 函数不变
    - _Requirements: 8.3_

- [x] 11. 清理旧代码
  - [x] 11.1 最终清理和验证
    - 确认 `src/types/agent.ts` 中不再包含 AgentPlan, AgentPlanRuntime, AgentPlanParseResult, AgentMode 等旧类型
    - 确认全局搜索 "suggest_only" 和 "confirm_then_execute" 无结果
    - 确认全局搜索 "parseAgentPlanFromText" 无结果
    - 移除 `XTerminal.tsx` 中所有未使用的 import 和变量
    - 确认 TypeScript 编译无错误
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 12. Final checkpoint - 确保所有测试通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- 每个任务引用了具体的需求编号以确保可追溯性
- Checkpoints 确保增量验证
- 属性测试使用 `fast-check` 库，每个属性最少 100 次迭代
- 单元测试验证具体示例和边界情况
- 建议安装 fast-check：`npm install --save-dev fast-check`
