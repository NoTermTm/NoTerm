# AI Code Block Display Fix Bugfix Design

## Overview

AI 助手面板（`AiRenderer2` 渲染出的 `.ai-renderer` 子树）中的围栏代码块在内容增长时被父级 flex 布局逐步挤扁，最终塌陷为一条线。根因是 `.ai-code-block` 同时存在 `display: flex; flex-direction: column` 和 `overflow: hidden`，被放在一个 `display: flex; flex-direction: column` 的 `.xterminal-ai-message` 父容器里，使得规范规定的 `min-height: auto`（按内容撑开）退化为 `min-height: 0`，从而成为可被压缩的 flex 子项。

修复策略是**仅调整 `.ai-code-block` 及其内部 `<pre>` 的 flex/尺寸约束**，让代码块在父级 flex 链中表现为不可压缩、由内容行数决定固有高度的块；同时显式声明 `<pre>` 的 `white-space: pre` 与 `flex: 0 0 auto`，确保多行结构、滚动条、工具栏、语法高亮、内联 code、命令块、用户消息等行为完全保留。所有改动局限在 `src/components/XTerminal.css` 的少量选择器，`AiRenderer2.tsx` 的 DOM 结构不变。

## Glossary

- **Bug_Condition (C)**：触发缺陷的输入条件——AI 助手输出的 markdown 中包含围栏代码块（fenced code block），且该代码块所在的 `.xterminal-ai-message` 在 flex 父级链中存在足够的同级内容压力（其它段落、列表、其它代码块等）使得 flex shrink 发生
- **Property (P)**：缺陷输入下的期望行为——`.ai-code-block` 的渲染高度由其内部 `<pre><code>` 的内容行数决定，并随内容增长而增长，不被父级 flex 布局压缩
- **Preservation**：缺陷条件不成立的输入（普通段落、列表、内联 `code`、用户/系统消息、`AgentStreamView` 的 thinking/done 块、终端命令块等）必须保持当前的渲染行为不变
- **`.ai-renderer`**：`AiRenderer2` 在 `src/components/AiRenderer2.tsx:126` 输出的根 `<div>`，承载 marked + DOMPurify 处理后的 HTML，规则定义在 `src/components/XTerminal.css` `.ai-renderer { ... }`（行 2464 起）
- **`.ai-code-block`**：`AiRenderer2.renderer.code` 包裹围栏代码块的 `<div>` 容器，规则在 `src/components/XTerminal.css` `.ai-code-block { ... }`（行 2505 起）
- **`.xterminal-ai-message`**：单条 AI 消息的容器，定义在 `src/components/XTerminal.css` 行 1795；该规则使用 `display: flex; flex-direction: column`
- **`.xterminal-ai-history`**：消息列表容器，`display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto;`（`src/components/XTerminal.css` 行 1670 起）
- **flex `min-height: auto` 退化规则**：CSS Flexbox 规范规定，当 flex item 的 `overflow` 不为 `visible` 时，其 `min-height: auto` 在主轴方向上等价于 `0`，从而允许该项被 flex-shrink 压缩到 0

## Bug Details

### Bug Condition

当 AI 助手在 `.xterminal-ai-message` 内渲染 markdown，且渲染产物中包含至少一个围栏代码块（被 `AiRenderer2.renderer.code` 包成 `<div class="ai-code-block">…</div>`）时，由于 `.ai-code-block` 在父级 flex column 布局中是可压缩的 flex 子项（`overflow: hidden` 导致 `min-height: auto` 退化为 `0`，且没有设置 `flex-shrink: 0`），随着同 message / 同面板内的其它 flex 同级内容（段落、列表、其它代码块等）增多并参与 flex shrink 分配，`.ai-code-block` 的渲染高度被持续压缩，最终远小于其内部 `<pre>` 的内容自然高度，呈现为一条细线。

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input = { markdown: string, panelContext: AiMessageRenderContext }
  OUTPUT: boolean

  RETURN containsFencedCodeBlock(input.markdown)
         AND renderedInsideFlexColumn(input.panelContext, ".xterminal-ai-message")
         AND aiCodeBlockHas(overflow: "hidden")
         AND aiCodeBlockMissing(flex-shrink: 0)
         AND aiCodeBlockMissing(min-height >= contentHeight)
         AND visibleHeightOf(".ai-code-block") < naturalContentHeightOf("pre code")
END FUNCTION
```

### Examples

- **Bug 触发**：用户向 AI 助手发送多个问题，AI 在最近一条 assistant 消息中先输出两段说明文字、再输出一段 ```` ```bash ```` 代码块（10 行）。**Expected**：代码块以 10 行高度展示，含工具栏与语法高亮。**Actual**：代码块仅显示为约 1 行高的细带，10 行内容被压在不到一行的空间里
- **Bug 触发**：同一条 AI 消息中先后有两个代码块，随着第二个代码块流式追加内容，第一个代码块的高度被进一步压缩，几乎不可读
- **Bug 触发**：AI 输出包含围栏代码块的同时还输出了无序列表与若干段落，代码块容器在 `.xterminal-ai-message` 的 flex 列中与其它子元素共同被 flex shrink 压缩，代码块首先塌陷
- **Bug 不触发（预期保留）**：AI 输出只包含一个简短代码块、没有任何同级 markdown 内容时，代码块以多行形式正常展示

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- `AiRenderer2.tsx` 中通过 `marked.Renderer` + `hljs` 生成的 `<div class="ai-code-block"><div class="ai-code-toolbar">…</div><pre><code class="language-... hljs">…</code></pre></div>` DOM 结构保持不变
- `.ai-code-toolbar` 中的 send / copy 按钮渲染条件、点击行为（写入终端、复制到剪贴板）保持不变
- `<code class="hljs">` 上的 highlight.js 颜色 token 与现有 `highlight.js/styles/github.css` 主题保持不变
- 单反引号内联 `code`（marked 默认走 `<code>` 而非 `.ai-code-block`）的现有内联样式（小背景、行内显示）不变
- `AgentStreamView` 中 thinking / done 块通过 `dangerouslySetInnerHTML` 渲染的 markdown 与 `agent-block__markdown pre` 的现有样式（`AgentStreamView.css`）不变
- 终端命令块（`agent-block--command`、`agent-command__cmd`、`agent-command__output`）的多行 `<pre>`、`white-space: pre-wrap`、滚动条与配色保持不变
- 用户消息（`xterminal-ai-message--user` 与 `agent-block--user`）以及错误消息块的对齐方式、背景色、文字颜色、折行行为不变
- `.ai-renderer` 自身的字号、`overflow-wrap: anywhere`、`word-break: break-word`、列表缩进、段落间距等保持不变

**Scope:**

修复仅作用在 `.ai-code-block`（含其 `pre`、`pre code.hljs`）这一组选择器以及其在父级 flex 链中作为 flex 子项的 shrink/min-height 约束上。所有不属于围栏代码块容器的 DOM 节点都不应被本次改动影响：

- `.xterminal-ai-message`、`.xterminal-ai-history`、`.xterminal-ai-body` 等父级容器自身的 flex 设置不动
- `AgentStreamView.css` 与 `AgentStreamView.tsx` 不动
- `AiRenderer2.tsx` 的 `renderer.code` 输出 HTML 字符串不动
- `src/index.css` 中的全局 `pre/code/kbd` 字体声明不动

## Hypothesized Root Cause

围栏代码块的 DOM 实际是被多层 flex 列容器包裹的：

```
.xterminal-ai-body          (display: flex; flex-direction: column; flex: 1; min-height: 0)
  └── .xterminal-ai-history (display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto)
        └── .xterminal-ai-message
            (display: flex; flex-direction: column;
             min-width: 0; max-width: 94%)         ← 子项默认 flex: 0 1 auto，可被 shrink
              ├── .xterminal-ai-meta / role
              └── .ai-renderer                      ← block，内含多个 markdown 子节点
                    └── .ai-code-block
                        (display: flex; flex-direction: column;
                         overflow: hidden;          ← 关键：触发 min-height: auto → 0
                         border-radius: 8px;
                         无 flex-shrink: 0
                         无 min-height)
                          ├── .ai-code-toolbar
                          └── <pre> (overflow-x: auto, 默认 block)
                                └── <code class="hljs">
```

基于上述结构和 bug 描述（代码块高度随同级内容增多而被持续挤压），最可能的根因是以下几点的叠加，按可能性从高到低排列：

1. **`.ai-code-block` 在父级 flex column 中的 `min-height` 退化为 0（最可能）**
   - `src/components/XTerminal.css` `.ai-code-block { overflow: hidden; ... }` 在第 2509 行
   - CSS Flexbox 规范：flex item 的 `overflow` 不为 `visible` 时，主轴 `min-height: auto` 退化为 `0`
   - `.xterminal-ai-message`（行 1795 起）使用 `display: flex; flex-direction: column`，使 `.ai-renderer` 成为其 flex 子项；而 `.ai-code-block` 又作为 `.ai-renderer` 内部的 block，受到祖先 flex 列布局对 `.ai-renderer` 的高度分配影响
   - 后果：当父 flex column 出现高度约束（容器 max-height、`.xterminal-ai-history` 的 `flex: 1; min-height: 0`，或多条同级内容竞争空间），`.ai-code-block` 可被 flex shrink 压到 0

2. **`.ai-code-block` 自身是 flex column 容器，但子项 `<pre>` 没有 `flex-shrink: 0`**
   - `.ai-code-block { display: flex; flex-direction: column; }`（行 2511–2512）
   - 内部 `<pre>` 是该 flex 容器的子项，默认 `flex: 0 1 auto`；当 `.ai-code-block` 自身被外部压缩到比内容矮，`<pre>` 也会被进一步 shrink，进一步加剧塌陷
   - `.ai-code-block pre { ... overflow-x: auto; ... }`（行 2518–2524）只控制水平滚动，未约束垂直方向

3. **`<pre>` 默认依赖浏览器 UA `white-space: pre`，未在 `.ai-code-block pre` 中显式声明**
   - 当前规则没有 `white-space` 的显式值
   - 现有上层规则 `.ai-renderer pre { background: transparent; margin: 2px 0; max-width: 100%; overflow-x: auto; }`（行 2498）也未显式声明
   - 一旦后续有任何选择器（或通过浏览器默认样式表的差异）影响到 `white-space`，多行换行就会被吞掉
   - 这不是当前主要根因，但是潜在的脆弱点

4. **`.ai-renderer > * { max-width: 100%; min-width: 0; box-sizing: border-box; }` 设置了 `min-width: 0` 但同时未在垂直方向给 `.ai-code-block` 任何最小高度兜底**
   - 行 2485–2489
   - 该规则本意是让长行可水平滚动，但放大了 `.ai-code-block` 在 flex 容器中被任意压缩的可能性

5. **`AgentStreamView.tsx` 的 `dangerouslySetInnerHTML` 路径不会触发该 bug**
   - `AgentStreamView` 中 `renderMarkdown` 不走 `AiRenderer2.renderer.code`，没有 `.ai-code-block` 包裹层；其代码块走 `agent-block__markdown pre`，使用 `padding`、`overflow-x: auto`、无 flex 列容器，不受同样 squeeze 影响
   - 结论：本 bug 仅在 `AiRenderer2` 的渲染路径上发生

## Correctness Properties

Property 1: Bug Condition - 围栏代码块在父级 flex column 中保持由内容决定的固有高度

_For any_ AI 助手渲染输入 `input` 满足 `isBugCondition(input)`（即 markdown 含围栏代码块且被放置在 `.xterminal-ai-message` flex column 父级链中），修复后的 `.ai-code-block` SHALL 渲染出与其内部 `<pre><code>` 内容行数对应的固有高度，即对应 `naturalContentHeightOf(pre code)` 的高度（含 `.ai-code-toolbar` 自身高度），且该高度不会随同级内容数量增加而减少。具体表现为：

- 多行代码块在视觉上以多行展示（≥ 内容行数 × 行高）
- 含换行的代码块保留每个 `\n` 对应的视觉换行
- 含超长行的代码块在 `<pre>` 内通过水平滚动显示，整体仍为多行
- 含语言标识的代码块继续应用 highlight.js 语法高亮

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

Property 2: Preservation - 非围栏代码块输入与现有同侧渲染行为完全一致

_For any_ AI 助手渲染输入 `input` 满足 `NOT isBugCondition(input)`（即不包含围栏代码块的 markdown，或不在 `AiRenderer2` 渲染路径上的内容，例如 `AgentStreamView` 的 thinking/done/command/output 块、`xterminal-ai-message--user` 用户消息等），修复后的 DOM 与样式输出 SHALL 与修复前完全一致，保留：

- 普通段落、列表、标题、链接等非代码块元素的现有渲染（Requirements 3.1）
- 内联 `` `code` `` 的现有内联代码样式（Requirements 3.2）
- assistant 角色代码块上的「执行」+「复制」按钮（Requirements 3.3）
- 非 assistant 角色代码块上仅显示「复制」按钮（Requirements 3.4）
- `AgentStreamView` 中 thinking / done 块通过 `dangerouslySetInnerHTML` 渲染的 markdown 样式（Requirements 3.5）
- 终端命令块（`agent-block--command`、`agent-command__cmd`、`agent-command__output`）的现有多行展示与 `white-space: pre-wrap` 行为（Requirements 3.6）
- 用户消息块与错误消息块的对齐、背景、颜色与折行行为（Requirements 3.7）

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

## Fix Implementation

### Changes Required

修复假设根因 1（`overflow: hidden` 引发 `min-height: auto → 0` 退化）和根因 2（`<pre>` 在 `.ai-code-block` flex 容器内可被 shrink）成立。所有改动集中在 `src/components/XTerminal.css` 的现有 `.ai-code-block` 选择器组，**不**改动 `AiRenderer2.tsx`、`AgentStreamView.css`、`AgentStreamView.tsx`、`src/index.css`。

**File**: `src/components/XTerminal.css`

**Selectors**: `.ai-code-block`、`.ai-code-block pre`、`.ai-code-block pre code.hljs`

**Specific Changes**:

1. **阻止 `.ai-code-block` 在父级 flex column 中被 shrink**（针对 1.4 / 2.5）
   - 在 `.ai-code-block` 规则块（约 2505 行起）追加 `flex-shrink: 0;` 与 `flex-grow: 0;`（或合并写为 `flex: 0 0 auto;`）
   - 追加 `min-height: max-content;` 作为兜底，覆盖因 `overflow: hidden` 触发的 `min-height: auto → 0` 退化；当浏览器不支持 `max-content` 时，`flex-shrink: 0` 已足以阻止压缩
   - 保留 `overflow: hidden`（用于裁切圆角与工具栏边界）

2. **保证 `.ai-code-block` 内部 `<pre>` 不被二次 shrink**（针对 1.1 / 1.2 / 2.1 / 2.2）
   - 在 `.ai-code-block pre` 规则块（约 2518 行起）追加 `flex: 0 0 auto;`
   - 显式声明 `white-space: pre;`，防止任何上层规则把多行折叠成单行；不使用 `pre-wrap` 是为了让超长行经由现有 `overflow-x: auto` 走水平滚动
   - 保留现有 `overflow-x: auto;`、`padding: 30px 10px 8px;`、`max-width: 100%;`、`min-width: 0;`

3. **保证 `<code class="hljs">` 仍以块级方式呈现**（针对 1.3 / 2.3 / 2.4）
   - `.ai-code-block pre code.hljs` 已有 `display: block;`，无需新增；显式补充 `white-space: inherit;` 以确保从 `<pre>` 继承 `pre`
   - 保留现有的 `font-family`、`font-size`、`line-height`、`color` 等

4. **不动其它选择器**（针对 3.1–3.7）
   - `.ai-renderer`、`.ai-renderer p/ul/ol/li/a/code/strong/em/span` 不改
   - `.ai-renderer pre`（一般 markdown `<pre>`，不含 `.ai-code-block` 包裹）不改
   - `.ai-code-toolbar`、`.ai-send-btn`、`.ai-copy-btn` 与暗色主题变量 `--ai-code-bg`、`--ai-code-border`、`--ai-code-toolbar-bg`、`--ai-code-fg` 不改
   - `.xterminal-ai-message`、`.xterminal-ai-message--assistant/--user/--system`、`.xterminal-ai-history`、`.xterminal-ai-body` 不改
   - `AgentStreamView.css` 中的 `agent-block__markdown pre`、`agent-command__cmd`、`agent-command__output` 不改

5. **回归保护**（针对 3.5 / 3.6）
   - 由于 `.ai-code-block` 选择器只匹配 `AiRenderer2.renderer.code` 输出的容器，且 `AgentStreamView` 不会输出该类名，本次改动天然不影响 `AgentStreamView` 路径
   - 由于 `.ai-renderer pre`（不在 `.ai-code-block` 内）的选择器优先级低于 `.ai-code-block pre`，新增的 `flex: 0 0 auto;` 不会影响一般 markdown `<pre>` 的现有样式

## Testing Strategy

### Validation Approach

测试分为两阶段：先在**未修复代码**上复现 bug 行为以确认根因，再在**修复代码**上验证 fix 与 preservation。所有测试都通过 DOM + 计算后样式（getComputedStyle / 元素 boundingRect）观察渲染结果，不依赖截图。

### Exploratory Bug Condition Checking

**Goal**：在实施修复前先在未修复代码上跑测试，观察 `.ai-code-block` 高度被压缩的现象，验证或推翻"`overflow: hidden` + flex column 父级"的根因假设。如果在隔离 jsdom + 注入完整 CSS 后仍无法复现压缩，需要重新审视是否还有其它根因（例如 `xterm.js` 的容器对外部 DOM 的副作用、运行时注入的内联样式等）。

**Test Plan**：构造一个最小化的渲染脚手架——在 jsdom 中创建 `.xterminal-ai-body > .xterminal-ai-history > .xterminal-ai-message--assistant`，把 `AiRenderer2` 的输出 HTML 插入其中，给容器一个有限高度（模拟 AI 面板容器），加载 `XTerminal.css`（或注入相关规则），然后断言 `.ai-code-block` 的 `clientHeight` 大于等于 `pre` 内容行数 × 行高。

**Test Cases**:

1. **单代码块 + 多段落**：一条消息含两段说明 + 一个 10 行代码块 + 一个列表，断言 `.ai-code-block` 的 `clientHeight ≥ 10 × line-height`（will fail on unfixed code）
2. **同消息内多个代码块**：一条消息含两个 6 行代码块，断言两个 `.ai-code-block` 的 `clientHeight` 都 `≥ 6 × line-height`（will fail on unfixed code）
3. **代码块跨多条消息**：连续追加 5 条 assistant 消息，每条都含一个代码块，最早一条消息内代码块的 `clientHeight` 不应随后续消息追加而减小（will fail on unfixed code）
4. **超长行**：一条消息含一个代码块，其中一行包含 400 个字符无空格，断言 `.ai-code-block` 仍多行展示（高度等于行数 × 行高），且 `<pre>` 的 `scrollWidth > clientWidth` 表示出现了水平滚动（may fail on unfixed code，主要观察整体高度是否被压）

**Expected Counterexamples**:

- 在未修复代码上，第 1、2 个用例的 `.ai-code-block.clientHeight` 显著小于内容自然高度，甚至接近 `.ai-code-toolbar` 的高度（约 1 行），证实 squeeze
- 可能根因：`.ai-code-block` 的 `overflow: hidden` 让其 `min-height: auto` 退化为 `0`；`<pre>` 在 `.ai-code-block` 这层 flex 容器内继续被 shrink

### Fix Checking

**Goal**：验证对所有满足 `isBugCondition(input)` 的输入，修复后的 `.ai-code-block` 高度等于其内容自然高度。

**Pseudocode:**

```
FOR ALL input WHERE isBugCondition(input) DO
  dom := renderInPanel_fixed(input)
  block := dom.querySelector(".ai-code-block")
  pre := block.querySelector("pre")
  toolbar := block.querySelector(".ai-code-toolbar")
  expectedHeight := contentLineCount(input) * resolvedLineHeight(pre) + paddingV(pre) + toolbar.offsetHeight
  ASSERT block.clientHeight >= expectedHeight - tolerance
END FOR
```

### Preservation Checking

**Goal**：验证对所有不满足 `isBugCondition(input)` 的输入，修复后渲染的 DOM、`getComputedStyle` 结果与修复前完全一致。

**Pseudocode:**

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  domOriginal := renderInPanel_original(input)
  domFixed    := renderInPanel_fixed(input)
  ASSERT domOriginal.outerHTML == domFixed.outerHTML
  ASSERT computedStyleSnapshot(domOriginal) == computedStyleSnapshot(domFixed)
END FOR
```

**Testing Approach**：对 preservation 部分推荐使用 property-based testing，因为：

- 可以从有限语法（段落 / 列表 / 标题 / 链接 / 内联 code / 用户消息文本 / agent block 类型）随机生成 markdown 输入，覆盖大量未触发 bug 的组合
- 能自动发现"我们以为不影响、但实际被新规则误伤"的 corner case（例如某种特殊嵌套是否因 `flex: 0 0 auto` 间接受影响）
- 比手工挑几个例子更稳健

**Test Plan**：先在未修复代码上对一组 preservation 输入采集快照（DOM 字符串 + 关键节点的 `getComputedStyle`），实施修复后对同一组输入再次采集，逐一比对相等性。

**Test Cases**:

1. **纯文本段落 + 列表**：观察未修复代码下 `.ai-renderer p`、`.ai-renderer ul/ol/li` 的渲染，写测试断言修复后输出与之相同（Requirements 3.1）
2. **内联 code**：观察未修复代码下 `code`（无 `.ai-code-block` 包裹）的样式，断言修复后 `display`、`background`、`padding`、`border-radius` 不变（Requirements 3.2）
3. **assistant 角色代码块的工具栏**：断言修复后仍渲染出 `.ai-send-btn` 与 `.ai-copy-btn` 两个按钮，按钮的 `data-action` / `data-code` 属性不变；并通过点击模拟验证 send / copy 行为不变（Requirements 3.3）
4. **非 assistant 代码块**：以 `role="user"` / `role="system"` 渲染同样代码，断言只有 `.ai-copy-btn`、没有 `.ai-send-btn`（Requirements 3.4）
5. **`AgentStreamView` 路径**：构造 thinking / done block，断言 `agent-block__markdown pre` 的 `getComputedStyle` 与未修复一致（Requirements 3.5）
6. **终端命令块**：构造 `agent-block--command` + `agent-block--command-output`，断言 `agent-command__cmd` 与 `agent-command__output` 的 `white-space`、`word-break` 与既有值一致（Requirements 3.6）
7. **用户消息与错误块**：断言 `xterminal-ai-message--user`、`agent-block--user`、`agent-block--error` 的 `align-self`、`background`、`color`、`white-space` 与既有值一致（Requirements 3.7）

### Unit Tests

- `.ai-code-block` 的 `clientHeight` 在含多行代码 + 多段同级内容时不被压缩
- `<pre>` 的计算样式 `white-space === "pre"`（修复后显式声明）
- `<pre>` 的 `flex-shrink` 计算值为 `0`
- `.ai-code-block` 的 `flex-shrink` 计算值为 `0`
- 单反引号内联 `code` 的渲染 DOM 不在 `.ai-code-block` 中（marked 默认行为）

### Property-Based Tests

- 随机生成包含 `[段落, 列表, 标题, 引用, 内联code, 围栏代码块×N]` 的 markdown，断言渲染结果中所有 `.ai-code-block` 的 `clientHeight ≥` 对应内容行数高度
- 随机生成不含围栏代码块的 markdown，断言修复前后 DOM outerHTML 与关键节点 computedStyle 完全相同
- 随机生成不同语言标识（`bash`、`ts`、`json`、空、未知语言等）的代码块，断言 highlight.js token 节点存在且数量稳定

### Integration Tests

- 在真实 AI 面板中流式追加多条含代码块的 assistant 消息，观察首条消息内代码块高度不随后续消息追加而变化
- 切换主题（bright / mint / dark）后代码块仍以多行展示，工具栏配色与变量 `--ai-code-bg`、`--ai-code-border` 行为一致
- 点击「执行」按钮把代码写入终端、点击「复制」按钮把代码写入剪贴板，行为均与修复前一致
- `AgentStreamView` 中执行命令、产生 thinking / done 块的渲染外观不受影响
