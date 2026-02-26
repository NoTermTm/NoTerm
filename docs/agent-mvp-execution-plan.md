# Agent MVP 执行方案（需用户确认后执行）

## 1. 目标与边界

### 1.1 目标
- 在 AI 对话框中生成可执行操作计划。
- 所有服务器操作必须经过用户确认后才执行。
- 执行过程可追踪、可中止、可审计。

### 1.2 非目标（MVP 不做）
- 无确认自动执行。
- 跨会话/跨服务器批量编排。
- 自动回滚（仅提供回滚建议，不自动执行）。

## 2. 里程碑总览

1. `M1` 协议与风险模型落地（仅建议，不执行）
2. `M2` 审批卡片 UI（可确认/拒绝）
3. `M3` 受控执行器（单步命令）
4. `M4` 审计日志（可回溯）
5. `M5` 多步顺序执行（最多 5 步）

## 3. 可执行步骤拆解

### Step 1: 定义 Agent 输出协议（JSON）
- 任务
1. 定义 `AgentPlan`、`AgentAction` TS 类型。
2. 约束字段：`id`、`session_id`、`command`、`risk`、`reason`、`expected_effect`、`timeout_sec`。
3. 在 AI 系统提示词中要求模型只输出协议格式（允许附简短说明）。
- 建议修改文件
1. `src/types/agent.ts`（新增）
2. `src/api/ai.ts`（增加 plan 解析函数）
3. `src/components/XTerminal.tsx`（接入 plan 消息状态）
- 验收标准
1. AI 输出可被稳定解析为结构化对象。
2. 解析失败时 UI 给出“计划解析失败”，不触发执行。

### Step 2: 实现风险分级与本地策略引擎（Policy）
- 任务
1. 落地命令白名单（只读、服务控制、文件操作等）。
2. 落地黑名单/危险模式（如 `rm -rf /`、`mkfs`、`dd`、`curl ... | bash`）。
3. 禁止默认多命令拼接（`;`、`&&`、`||`、`|`）。
4. 输出校验结果：`allowed | blocked | needs_strong_confirmation`。
- 建议修改文件
1. `src/terminal/agentPolicy.ts`（新增）
2. `src/components/XTerminal.tsx`（执行前调用 policy）
- 验收标准
1. 高危命令被拦截或要求强确认。
2. 低风险命令可进入审批流程。

### Step 3: 审批卡片 UI（AI 面板内）
- 任务
1. 在 AI 对话区渲染“待执行计划卡片”。
2. 每个 action 提供：`确认执行`、`拒绝`、`复制命令`、`编辑后执行`。
3. 中高风险动作增加二次确认（输入 `CONFIRM`）。
4. 明确展示目标会话、风险级别、超时、预期影响。
- 建议修改文件
1. `src/components/XTerminal.tsx`
2. `src/components/XTerminal.css`
3. `src/i18n/index.ts`
- 验收标准
1. 未确认时无法执行。
2. 点击确认后才进入执行状态。
3. UI 能正确显示 blocked 原因。

### Step 4: 受控执行器（单步）
- 任务
1. 新增“受控执行命令”接口（建议在 Tauri Rust 命令层实现）。
2. 输入参数：`sessionId`、`command`、`timeoutSec`。
3. 输出参数：`exitCode`、`stdout`、`stderr`、`durationMs`。
4. 增加超时与取消机制。
- 建议修改文件
1. `src-tauri/src/lib.rs`（注册命令）
2. `src-tauri/src/ssh_manager.rs` / `src-tauri/src/local_pty.rs`（执行逻辑）
3. `src/api/ssh.ts`（新增前端调用）
4. `src/components/XTerminal.tsx`（接执行结果）
- 验收标准
1. 命令执行结果可回传到 AI 面板。
2. 超时后能正确结束并返回状态。
3. 执行失败不会自动重试。

### Step 5: 审计日志
- 任务
1. 每次执行记录：时间、会话、用户原始请求、AI 计划、最终命令、确认人动作、结果。
2. 脱敏敏感信息（token、密码、私钥片段）。
3. 记录写入本地持久化（JSONL 或 store）。
- 建议修改文件
1. `src/terminal/agentAudit.ts`（新增）
2. `src/components/XTerminal.tsx`
3. `src/store/`（可选新增审计存储）
- 验收标准
1. 任一执行都有对应审计记录。
2. 日志中无明文敏感信息。

### Step 6: 多步顺序执行（最多 5 步）
- 任务
1. 支持逐步执行：前一步成功后进入下一步。
2. 任一步失败立即停止并展示失败步骤。
3. 支持“执行后续步骤”与“停止后续步骤”。
- 建议修改文件
1. `src/components/XTerminal.tsx`
2. `src/types/agent.ts`
- 验收标准
1. 失败时不会继续执行剩余步骤。
2. 用户可中止后续步骤。

## 4. 测试清单（必须）

1. 协议解析测试：合法/非法 JSON、字段缺失、风险等级非法值。
2. Policy 测试：白名单通过、黑名单拦截、拼接命令拦截。
3. UI 测试：确认按钮、二次确认、拒绝路径、编辑后执行。
4. 执行器测试：成功、失败、超时、取消。
5. 审计测试：记录完整、字段脱敏、失败路径可追溯。

## 5. 发布顺序建议

1. 灰度开关：`Agent Mode = Suggest Only / Confirm Then Execute`。
2. 先对本地会话开放，再扩展到 SSH 会话。
3. 默认关闭多步执行，单步稳定后再开启。

## 6. 回滚预案

1. 保留“仅建议模式”作为兜底。
2. 执行器异常时自动降级为“只生成计划不执行”。
3. 保留审计日志，便于回放故障。

## 7. 待确认决策（开始开发前）

1. 高风险动作是否允许“强确认后执行”，还是一律拦截？
2. 审计日志保存周期与容量上限是多少？
3. 是否允许用户编辑 AI 生成命令后执行（默认建议允许）？
4. 多步计划是“逐步确认”还是“一次批准整单”？
