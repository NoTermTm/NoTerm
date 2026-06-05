# Bugfix Requirements Document

## Introduction

在 AI 助手的渲染面板（`AiRenderer2`）中，当 AI 输出的 markdown 内容包含围栏代码块（fenced code blocks，使用三个反引号包裹的代码块，例如 ```` ```bash ... ``` ````）时，代码块没有按照原始的多行格式稳定展示，而是会随着所在消息 / 对话面板里 markdown 总内容的不断增长，**高度被父级容器逐步压缩（squeeze）**，最终被压成一条几乎看不到任何代码行的细线，导致用户无法直接读到完整的代码内容、无法判断代码结构，也很难选中或复制具体的某一行。

值得注意的是，问题并不是“代码块从一开始就被渲染为一行”：在内容较少时代码块仍可能正常以多行展示，缺陷的关键症状是其**可见高度会随上下文（段落、其他代码块、列表等同级内容）增多而被持续挤扁**，呈现出一种动态收缩的回归现象，而不是一次性的渲染错误。

该缺陷影响用户使用 AI 助手获取脚本/命令/配置示例时的可读性和体验，是一个纯展示层（渲染 + 样式）的回归问题，预期通过修正 `AiRenderer2.tsx` 的代码块渲染逻辑和/或对应的 CSS（`XTerminal.css` 中的 `.ai-code-block`、`AgentStreamView.css`、`src/index.css`）来恢复正常的多行展示。修复必须保留已有的工具栏（执行 / 复制按钮）、语法高亮（highlight.js）、以及非代码块内容（段落、列表、内联 code、用户消息等）的现有渲染行为。

## Bug Analysis

### Current Behavior (Defect)

当 AI 助手输出包含围栏代码块的 markdown 内容时，代码块在 `AiRenderer2` 渲染出的 DOM 中无法以多行形式稳定展示：在内容较少时它可能还能多行显示，但随着对话/消息中 markdown 总量的增长，代码块的可见高度会被父级容器持续压缩，最终被挤成一条细线，用户看不到完整的代码内容。

1.1 WHEN AI 助手输出的 markdown 内容包含围栏代码块（```` ```lang\n...\n``` ````），THEN 该代码块在 `AiRenderer2` 的渲染结果中可能被显示为单行（高度异常小、所有行被合并/压缩在一行内），用户无法看到代码原有的多行结构

1.2 WHEN AI 助手输出的代码块内容包含多个换行符（`\n`），THEN 渲染后的 `<pre><code>` 区域中换行未在视觉上被保留为可读的多行布局（高度被压缩到不足以容纳所有行），用户无法逐行阅读代码

1.3 WHEN AI 助手输出的代码块包含超出容器宽度的长行，THEN 由于代码块被压缩成单行，用户既无法看到完整代码、也无法通过水平滚动正常浏览代码内容

1.4 WHEN AI 助手所在消息 / 对话面板的 markdown 总内容（段落、其他代码块、列表等同级内容）持续增长，THEN 代码块容器的可见高度会随之被父级布局持续压缩（动态 squeeze），即便代码块自身内容（行数）没有变化，其高度也会越来越小，最终被压成一条线，而不是保持由内容行数决定的固有高度

### Expected Behavior (Correct)

代码块应按其原始多行结构进行展示，并保留语法高亮和工具栏；对于超长行，则通过水平滚动显示，以保证代码完整可读。代码块的可见高度应仅由其自身内容（行数）决定，不受其所在父级布局中其它内容多少的影响。

2.1 WHEN AI 助手输出的 markdown 内容包含围栏代码块，THEN the system SHALL 在 `AiRenderer2` 中以多行 `<pre><code>` 的方式渲染该代码块，每一行都对应原始代码中的一行，且代码块容器高度随内容行数自适应增长

2.2 WHEN AI 助手输出的代码块内容包含换行符（`\n`），THEN the system SHALL 在视觉上保留这些换行（通过 `<pre>` 默认的 `white-space: pre`/`pre-wrap` 行为），不得将多行合并为单行

2.3 WHEN AI 助手输出的代码块中存在超出容器宽度的长行，THEN the system SHALL 在保持其它行为多行布局的前提下，仅对超长行启用水平滚动（`overflow-x: auto`），整体代码块仍呈现为多行可读状态

2.4 WHEN AI 助手输出的代码块包含语言标识（如 ```` ```bash ````、```` ```ts ````），THEN the system SHALL 在多行展示的基础上继续应用 highlight.js 的语法高亮，颜色和分行不得相互破坏

2.5 WHEN AI 助手所在消息 / 对话面板的 markdown 总内容持续增长（出现更多段落、其他代码块、列表等同级内容），THEN the system SHALL 保证代码块容器在其父级布局中不被收缩（即始终保持由其自身内容行数决定的固有高度），代码块的可见高度不得随同级内容数量的增加而被挤压变小

### Unchanged Behavior (Regression Prevention)

修复仅针对围栏代码块的多行展示问题，不得改变 `AiRenderer2` 及相关组件中其它已有的渲染行为。

3.1 WHEN AI 助手输出的 markdown 内容是普通段落、列表、标题、链接等非代码块元素，THEN the system SHALL CONTINUE TO 按照现有的 `AiRenderer2` 渲染规则进行渲染（段落间距、列表缩进、链接样式等保持不变）

3.2 WHEN markdown 内容中使用单反引号包裹的内联 `code`（例如 `` `foo()` ``），THEN the system SHALL CONTINUE TO 以现有内联代码样式（小背景、行内显示）进行渲染，不得被错误地转成块级代码块

3.3 WHEN 代码块由 `role === "assistant"` 角色产生且 `AiRenderer2` 的工具栏渲染条件未变，THEN the system SHALL CONTINUE TO 在代码块上方显示「执行」（send）和「复制」（copy）按钮，且按钮的点击行为（写入终端 / 复制到剪贴板）保持现有逻辑

3.4 WHEN 代码块由非 assistant 角色（user / system）产生，THEN the system SHALL CONTINUE TO 仅显示「复制」按钮、不显示「执行」按钮（保持现有 `showSend` 判断逻辑）

3.5 WHEN AI 助手输出在 `AgentStreamView` 的 thinking / done 等块中以 `dangerouslySetInnerHTML` 方式渲染的 markdown，THEN the system SHALL CONTINUE TO 按 `AgentStreamView.css` 中的现有样式渲染（不会因为本次 `AiRenderer2` / 全局 CSS 的修复而出现样式破坏或越界覆盖）

3.6 WHEN 终端命令块（`agent-block--command`、`agent-command__cmd`、`agent-command__output` 等）渲染命令与输出内容，THEN the system SHALL CONTINUE TO 保持其现有的多行 `<pre>` 展示、`white-space: pre-wrap`、滚动条与配色行为，不应受本修复影响

3.7 WHEN 用户消息块（`agent-block--user` 或 `xterminal-ai-message--user`）以及错误消息块渲染时，THEN the system SHALL CONTINUE TO 保持现有的对齐方式、背景色、文字颜色与折行行为
