# Implementation Plan

## Overview

修复 `src/components/XTerminal.css` 中 `.ai-code-block`、`.ai-code-block pre`、`.ai-code-block pre code.hljs` 三个选择器，使围栏代码块在父级 flex column 链中保持由内容行数决定的固有高度，不被同级 markdown 内容挤压。

任务采用 bugfix workflow：先用 property-based test 复现 bug（exploratory bug condition checking），再写 preservation property tests 锚定 baseline，最后实施 CSS 修复并验证 fix checking + preservation checking。

## Notes

- 测试基础设施：本仓库 `package.json` 已声明 `vitest`，但 `vitest.config.ts` 当前未指定 `environment`。新增的 DOM 测试需要在 `jsdom` 环境下运行（验证 `getComputedStyle` / `clientHeight` 等），所以测试文件须在文件顶部添加 `// @vitest-environment jsdom`，或在 vitest 配置中切换到 jsdom。若仓库尚未安装 jsdom，先 `npm i -D jsdom` 再写测试。
- Property-based 测试推荐 `fast-check`；若仓库未安装，先 `npm i -D fast-check`。
- 命令：`npm run test`（即 `vitest run`）。
- 任务 1（exploration）必须在未修复代码上 **失败**；任务 2（preservation）必须在未修复代码上 **通过**；任务 3.2 / 3.3 在修复后必须全部 **通过**。
- 关联文档：`.kiro/specs/ai-code-block-display-fix/bugfix.md`（验收条款 1.1–3.7）、`.kiro/specs/ai-code-block-display-fix/design.md`（Bug Details、Correctness Properties、Fix Implementation）。

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2"] },
    { "wave": 2, "tasks": ["3.1"] },
    { "wave": 3, "tasks": ["3.2", "3.3"] },
    { "wave": 4, "tasks": ["4"] }
  ]
}
```

```
1 (exploration test, fails on unfixed)
2 (preservation tests, pass on unfixed)
        \  /
         v
3.1 (CSS fix in XTerminal.css)
         |
         +--> 3.2 (re-run task 1, must now pass)
         |
         +--> 3.3 (re-run task 2, must still pass)
                       |
                       v
                       4 (full suite + manual smoke)
```

依赖说明：

- 1 与 2 互相独立，可并行编写，但都必须先于 3.1 完成
- 3.1 必须在 1 与 2 完成后才能开始（否则没有 baseline 验证修复正确性）
- 3.2 与 3.3 复用 1 与 2 的同一份测试文件，不写新测试
- 4 依赖 3.2 与 3.3 全部通过

## Tasks

- [-] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - 围栏代码块在父级 flex column 中被挤压成细线
  - **CRITICAL**: 本测试必须在 **未修复代码** 上运行并 **失败** —— 失败本身就是 bug 存在的证据。
  - **DO NOT attempt to fix the test or the code when it fails** —— 失败是预期，记录反例后停止。
  - **NOTE**: 本测试同时编码了修复后的期望行为（Property 1: Expected Behavior），后续修复完成时再次运行它即可作为 fix checking。
  - **GOAL**: 暴露反例，证明 `.ai-code-block` 在父级 `.xterminal-ai-message` flex column 链中会被同级 markdown 内容挤压到远小于其 `<pre>` 自然高度。
  - **Scoped PBT Approach**：bug 的触发是确定性的（CSS 计算样式 + flex shrink），先把 property 收紧到 design.md 中列出的具体场景，确保可复现：
    - 场景 A：单条消息 = 两段说明 + 一个 10 行 ```bash 代码块 + 一个三项无序列表（对应 design.md Bug Details · Examples 第 1 条）
    - 场景 B：单条消息内含两个 6 行代码块（对应 Examples 第 2 条）
    - 场景 C：连续追加 5 条 assistant 消息，每条含一个 8 行代码块；观察首条消息内代码块（对应 Examples 第 3 条）
  - 测试脚手架（落在 `src/components/AiRenderer2.codeBlock.test.tsx`，文件顶部加 `// @vitest-environment jsdom`）：
    1. 在 jsdom 中渲染 `<div class="xterminal-ai-body"><div class="xterminal-ai-history"><div class="xterminal-ai-message xterminal-ai-message--assistant">…</div></div></div>` 并给祖先 `.xterminal-ai-history` 一个有限高度（如 320px）
    2. 用 `<style>` 注入 `XTerminal.css` 中与 `.xterminal-ai-body` / `.xterminal-ai-history` / `.xterminal-ai-message` / `.ai-renderer` / `.ai-code-block` / `.ai-code-block pre` / `.ai-code-toolbar` 相关的全部规则（保留原文件中的当前定义，不要改）
    3. 用 `AiRenderer2` 的 `marked.Renderer` 走 React render（或直接复用 `renderer.code` 输出 HTML 字符串塞入 `.ai-renderer`）
    4. `block = container.querySelector('.ai-code-block')`、`pre = block.querySelector('pre')`、`toolbar = block.querySelector('.ai-code-toolbar')`
  - 断言（来自 design.md `## Correctness Properties` Property 1 + Bug Details · isBugCondition）：
    - `getComputedStyle(block).flexShrink === '0'`（修复前为默认 `1`，断言失败）
    - `parseFloat(getComputedStyle(pre).flexShrink) === 0`（修复前为默认 `1`，断言失败）
    - `getComputedStyle(pre).whiteSpace === 'pre'`（修复前 `.ai-code-block pre` 没有显式声明，仅依赖 UA 默认；按规则查可能落到 `normal`，断言失败）
    - `block.clientHeight >= contentLineCount * resolvedLineHeight(pre) + paddingV(pre) + toolbar.offsetHeight - tolerance`（修复前 flex shrink 后此断言失败）
  - **Run the test on UNFIXED code**
  - **EXPECTED OUTCOME**：测试 **FAIL**（这是正确结果，说明 bug 已被复现）
  - 在测试输出中记录反例：例如 `场景 A: block.clientHeight = 28px (toolbar 高度) ≪ 期望 ≥ 200px`，以及 `getComputedStyle(block).flexShrink === '1'`
  - 任务标记完成的条件：测试已写好、已运行、反例已记录在测试输出 / spec 评论中
  - _Validates: design.md Property 1_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5_

- [-] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - 非围栏代码块输入与现有同侧渲染行为完全一致
  - **IMPORTANT**: 遵循 observation-first 方法 —— 先在 **未修复代码** 上观察并采集真实输出，再据此写 property test，而不是按主观假设写。
  - 测试落在 `src/components/AiRenderer2.preservation.test.tsx`（顶部 `// @vitest-environment jsdom`）。
  - **Step 1 — 观察**：在未修复代码上运行 `AiRenderer2` 渲染如下输入并采集快照：
    - 纯文本段落 + 列表（命中 bugfix.md 3.1）
    - 内联 `` `code` ``（命中 3.2）
    - `role="assistant"` 含围栏代码块的消息 → 观察 `.ai-send-btn` + `.ai-copy-btn` 的 DOM、`data-action` / `data-code` 属性、点击行为（命中 3.3）
    - `role="user"` / `role="system"` 含围栏代码块的消息 → 观察仅 `.ai-copy-btn` 存在、无 `.ai-send-btn`（命中 3.4）
    - `AgentStreamView` 路径下的 thinking / done block（命中 3.5）—— 走 `AgentStreamView.tsx` + `AgentStreamView.css`
    - `agent-block--command` + `agent-command__cmd` + `agent-command__output`（命中 3.6）
    - `xterminal-ai-message--user`、`agent-block--user`、`agent-block--error`（命中 3.7）
  - 采集每个用例的：`outerHTML`、关键节点的 `getComputedStyle`（`display`、`white-space`、`background`、`color`、`padding`、`border-radius`、`align-self`、`word-break`）
  - **Step 2 — 写 property tests**（property-based，用 `fast-check` 或自带的简易随机生成器；优先 `fast-check`，若仓库未安装则按 `npm i -D fast-check` 加入 devDependency）：
    - **Prop 2.1**（命中 3.1）：随机生成 `[段落, 标题(h1-h6), 链接, 引用, 无/有序列表]` 的组合，断言 `getComputedStyle(p|li|h*|a)` 在修复前后等价（先把"修复前快照"通过常量保存进测试，断言"当前 DOM 与该快照相等"）
    - **Prop 2.2**（命中 3.2）：随机生成含单反引号内联 code 的段落，断言生成 DOM 中所有 `code` 节点的最近 `.ai-code-block` 祖先为 `null`，且其 `display` 不是 `block`
    - **Prop 2.3**（命中 3.3）：随机生成 `role="assistant"` 的代码块，断言每个 `.ai-code-block` 内同时存在 `.ai-send-btn` 与 `.ai-copy-btn`，二者 `data-action` 分别为 `"send"` / `"copy"`，`data-code` 解码后等于原始代码；模拟点击复制按钮断言 `navigator.clipboard.writeText` 被调用
    - **Prop 2.4**（命中 3.4）：随机生成 `role="user" | "system"` 的代码块，断言只有 `.ai-copy-btn`、不存在 `.ai-send-btn`
    - **Prop 2.5**（命中 3.5）：通过 `AgentStreamView` 渲染随机 markdown 的 thinking / done block，断言 `.agent-block__markdown pre` 的 `getComputedStyle` 与采集快照相等（特别是 `white-space`、`padding`、`overflow-x`）
    - **Prop 2.6**（命中 3.6）：随机生成命令 + 输出文本，断言 `.agent-command__cmd` / `.agent-command__output` 的 `white-space === "pre-wrap"` 与现有值一致
    - **Prop 2.7**（命中 3.7）：断言 `.xterminal-ai-message--user` / `.agent-block--user` / `.agent-block--error` 的 `align-self`、`background`、`color`、`white-space` 与现有值一致
  - **Run all preservation tests on UNFIXED code**
  - **EXPECTED OUTCOME**：所有 preservation 测试 **PASS**（确认未修复代码的 baseline 行为，作为修复后回归比对的锚点）
  - 任务标记完成的条件：测试已写好、已在未修复代码上运行、全部通过、快照已嵌入测试
  - _Validates: design.md Property 2_
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [ ] 3. Fix for `.ai-code-block` 在父级 flex column 中被挤压

  - [~] 3.1 实施修复 —— 修改 `src/components/XTerminal.css`
    - 选择器 1：`.ai-code-block`（约第 2505 行起，`overflow: hidden;` 所在规则块）
      - 追加 `flex: 0 0 auto;`（即 `flex-grow: 0; flex-shrink: 0; flex-basis: auto;`）—— 阻止其作为父级 flex column 的子项被 shrink
      - 追加 `min-height: max-content;` —— 兜底覆盖 `overflow: hidden` 引发的 `min-height: auto → 0` 退化
      - 保留现有 `overflow: hidden;`、`border-radius`、`background`、`border`、`display: flex; flex-direction: column;`、`min-width: 0;`、`max-width: 100%;`、`margin: 10px 0;`
    - 选择器 2：`.ai-code-block pre`（约第 2518 行起）
      - 追加 `flex: 0 0 auto;` —— 在 `.ai-code-block` 这层 flex column 内不允许 `<pre>` 被二次 shrink
      - 追加 `white-space: pre;` —— 显式声明，防止任何上层规则把多行折叠为单行；不用 `pre-wrap`，让超长行经现有 `overflow-x: auto` 走水平滚动
      - 保留现有 `margin: 0;`、`padding: 30px 10px 8px;`、`min-width: 0;`、`max-width: 100%;`、`overflow-x: auto;`
    - 选择器 3：`.ai-code-block pre code.hljs, .ai-code-block pre .hljs`（约第 2525 行起）
      - 追加 `white-space: inherit;` —— 显式从 `<pre>` 继承 `pre` 语义，避免后续主题或 hljs 样式覆盖
      - 保留现有 `padding: 0; margin: 0; background: transparent; display: block; color; min-width; max-width; font-family; font-size; line-height`
    - 不改其它任何选择器：`.ai-renderer*`、`.ai-renderer pre`（不在 `.ai-code-block` 内的）、`.ai-code-toolbar`、`.ai-send-btn`、`.ai-copy-btn`、`.xterminal-ai-message*`、`.xterminal-ai-history`、`.xterminal-ai-body`、`AgentStreamView.css` 内全部规则、`src/index.css` 全局 `pre/code/kbd` 字体声明
    - 不改 `AiRenderer2.tsx`、`AgentStreamView.tsx` 的 DOM 结构与渲染逻辑
    - _Bug_Condition: design.md `## Bug Details · isBugCondition` —— `containsFencedCodeBlock(input.markdown) AND renderedInsideFlexColumn(input.panelContext, ".xterminal-ai-message") AND aiCodeBlockHas(overflow: "hidden") AND aiCodeBlockMissing(flex-shrink: 0) AND aiCodeBlockMissing(min-height >= contentHeight) AND visibleHeightOf(".ai-code-block") < naturalContentHeightOf("pre code")`_
    - _Expected_Behavior: design.md `## Correctness Properties` Property 1 —— `block.clientHeight ≥ contentLineCount × line-height + paddingV(pre) + toolbar.offsetHeight`，且高度不随同级内容增加而减小_
    - _Preservation: design.md `## Expected Behavior · Preservation Requirements` —— 改动只发生在 `.ai-code-block` 三组选择器内，不影响 `.ai-renderer pre`、`.xterminal-ai-message*`、`AgentStreamView.css`、`src/index.css`_
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5_

  - [~] 3.2 验证 bug condition 探索测试现已通过（fix checking）
    - **Property 1: Expected Behavior** - 围栏代码块在父级 flex column 中保持固有高度
    - **IMPORTANT**: 重新运行任务 1 中已编写的同一个测试，**不要写新测试**
    - 任务 1 的断言已经编码了期望行为，此时测试通过即等价于：
      - `getComputedStyle(.ai-code-block).flexShrink === '0'`（修复后由新增 `flex: 0 0 auto;` 满足）
      - `getComputedStyle(.ai-code-block pre).flexShrink === '0'`
      - `getComputedStyle(.ai-code-block pre).whiteSpace === 'pre'`
      - 三场景的 `block.clientHeight ≥ 内容自然高度`
    - 命令：`npm run test -- AiRenderer2.codeBlock`
    - **EXPECTED OUTCOME**：测试 **PASS**（确认 bug 已修复，三个反例不再出现）
    - _Validates: design.md Property 1, Requirements 2.1, 2.2, 2.3, 2.4, 2.5_

  - [~] 3.3 验证 preservation 测试仍然通过（preservation checking）
    - **Property 2: Preservation** - 非围栏代码块输入与现有同侧渲染行为完全一致
    - **IMPORTANT**: 重新运行任务 2 中已编写的全部 preservation property 测试，**不要写新测试**
    - 命令：`npm run test -- AiRenderer2.preservation`（同时确保运行涉及 `AgentStreamView` 的 spec）
    - **EXPECTED OUTCOME**：Prop 2.1 ~ Prop 2.7 全部 **PASS**（确认无回归）
    - 若任一 preservation 失败：停止，定位是新增的三处 CSS 规则中哪一条越界影响了非 `.ai-code-block` 节点；不要绕过失败
    - _Validates: design.md Property 2, Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [~] 4. Checkpoint - 全量测试与人工冒烟
  - 运行 `npm run test`，确保仓库内全部 vitest 用例（包括 `agentResponseParser.test.ts` 与新增的两个文件）一次通过
  - 在开发机上 `npm run dev`，手动复盘 design.md 列出的三种触发场景：
    - 单代码块 + 多段落 + 列表 → 代码块多行展示
    - 同消息内多个代码块 → 两个块都保持各自固有高度
    - 5 条流式 assistant 消息 → 首条消息内代码块高度不随后续追加而缩小
  - 切换主题（bright / mint / dark）确认 `--ai-code-bg`、`--ai-code-border`、`--ai-code-toolbar-bg` 工具栏配色未受影响
  - 点击「执行」按钮把代码写入终端、点击「复制」按钮把代码写入剪贴板，行为与修复前一致
  - 触发 `AgentStreamView` 路径（执行命令 / 产生 thinking / done block），外观与现有完全一致
  - 若任一冒烟项异常，停止并向用户提问而非继续推进
