# 写入闭环设计（Write Feedback Loop）

## 0. 现状：开环

```
扩展 → POST /v1/rewrite → 模型返回 {"kind":"write","text":…}
     → 扩展自行写入（paste / execCommand）
     → ✗ 什么都不回传
```

后果（都是本项目实测过的真实失败模式）：

- 编辑器焦点不在目标块 → paste 落到**别的块**，扩展自己也不知道
- 选区/锚点在重绘后失效 → 静默不写，或写到错误位置
- Markdown 被引擎降级成纯文本 → 模型以为样式生效了
- 配对 / HTTP 失败 → 模型完全无感

→ 模型「以为自己写对了」，正是要解决的问题。

## 1. 参考：DSH 的工具契约（@deepseek-ai/dsh-tools）

```ts
interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition          // 必须声明
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}
interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode                // 规范化返回值必须符合
  render(args: unknown, value: JsonValue): ContentBlock[]   // 投影成模型可见内容
}
interface ToolErrorInfo { name: string; code: string }        // 结构化错误码
interface ToolFailure   { message: string; info?: ToolErrorInfo }  // 人话 + 码
```

可借用的三条约定：

1. **成功也必须声明输出契约**（`output.schema`）→ 强迫工具说清「到底发生了什么」
2. **`render()` 决定模型看到什么** → 可以把 `ok/code/hint` 渲染成一句人话
3. **失败带 `code`** → 调用方按码分流；另有 `TOOL_ABORTED` / `TOOL_ABORTED_BEFORE_DISPATCH` 两个规范取消码

## 2. 设计原则

- **可预期的失败 → 返回值**（带 code / hint / retryable），模型能看到 hint
- **不可预期的失败（基础设施）→ 抛出**带 code 的错误（`BRIDGE_DOWN` 等）
- **成功也要报告「实际写到哪了」**（`observed`），而不是只给 `ok:true`
- 每个错误必须回答三件事：**发生了什么 / 能不能重试 / 下一步做什么**

## 3. 主路径：把「写入」变成工具（同步闭环）

复用**桌面胶囊那套已有的 Host↔扩展命令通道**（`/v1/desktop/pending` + `/v1/desktop/result`）：

```
模型调用 page_write({text, intent, format})
  → host 把命令入队 { commandId, selectionId, payload }
  → 扩展端取命令并执行（它本来就在轮询 / 绑定选区）
  → 扩展 POST /v1/apply/result { commandId, ok, code, observed, detail }
  → host 解开该工具调用
  → execute 返回规范化值 → render() 变成模型可见的一句话
```

**关键收益：模型在同一轮内拿到结果**，可以立刻重试或换策略，而不是等下一轮。

（`ToolRunContext.deferContext()` / `concludeTurn()` 也可用：写入确认后把「已写入」作为下一轮上下文。）

## 4. 输出契约

成功：

```json
{
  "ok": true,
  "code": "APPLIED",
  "observed": {
    "blockId": "...", "kind": "heading2",
    "textBefore": "...", "textAfter": "...",
    "styles": { "color": "rgb(216,57,49)" },
    "autoNumbered": true
  },
  "verifiedBy": "engine-render",
  "hint": "已写入，块类型保持 heading2"
}
```

失败：

```json
{
  "ok": false,
  "code": "NOT_FOCUSED",
  "message": "编辑器焦点在别的块上，本次没有写入",
  "observed": { "focusedBlockId": "...", "targetBlockId": "..." },
  "retryable": true,
  "hint": "重新点击目标块后再试一次；或改用整块替换"
}
```

## 5. 语义化错误码表

| code | 触发条件 | retryable | 模型下一步 |
| --- | --- | --- | --- |
| `APPLIED` | 写入且校验通过 | — | 完成 |
| `NOT_RENDERED` | 文本落地但样式没生效 | ✅ | 改用纯文本 / 去掉不可表达的格式 |
| `NOT_FOCUSED` | `.text-editor-focused` ≠ 目标块 | ✅ | 重新定位后再写 |
| `TARGET_MOVED` | 页面重绘 / 锚点失效 | ✅ | 重新读取上下文再写 |
| `WRONG_TARGET` | 目标块没变、别处变了 | ✅ 一次 | 重试一次，再失败就放弃并告知 |
| `READ_ONLY` | 无编辑权限 / 只读模式 | ❌ | 停止写入，告知用户 |
| `EDITOR_REJECTED` | 引擎 schema 校验失败 | ✅ | 调整内容（如 `emoji_value` 必须统一码点） |
| `PAGE_CHANGED` | URL / 文档已切换 | ❌ | 让用户重新选择 |
| `BRIDGE_DOWN` | 配对失效 / HTTP 错误 / 超时 | ❌ | 不要重试写入，先告知用户 |
| `CANCELLED` | 用户中止 | ❌ | 停止 |

（`BRIDGE_DOWN` / `CANCELLED` 走**抛出**路径；其余走**返回值**路径。）

## 6. 扩展侧要补的检测（当前缺的）

`applyFeishuMarkdown` 目前只做「文本有没有出现」的粗校验，要补：

1. 写入前记录**目标块的 id / kind / text**（DOM 已有 `data-block-id` / `data-block-type`）
2. 写入后确认**目标块本身**变了；若目标块没变而别处变了 → `WRONG_TARGET`
3. 记录 `.text-editor-focused` 是否等于目标 zone → `NOT_FOCUSED`
4. 用 `heading-order` 等 DOM 标记确认样式真的渲染了 → `NOT_RENDERED`

这四条正好复用第 1 步已经写好的 `extractBlockContext`。

## 7. 兜底：延迟反馈

当写入仍由扩展自动应用（非工具路径）时：扩展 POST `/v1/applied`，Host 记进会话，
下一轮注入 `lastApply`。**语义与工具结果完全一致**（同一套 code），所以模型不需要学两套。

## 8. 与现有 envelope 的关系

- envelope 继续负责**内容**：`{"kind":"write","text":…}`
- 工具负责**写入这个动作**及其结果
- 两者并存：模型先在回答里给内容，再调用 `page_write` 落地；或工具参数直接带 `text`
- 第 2 步的 `format` 字段天然成为 `page_write` 的一个参数

## 9. 落地顺序

1. **扩展侧补齐 observed / 检测**（不改协议，先把「看得到」做出来）
2. **加 `/v1/applied` + 下一轮注入 `lastApply`**（延迟闭环，改动最小）
3. **注册 `page_write` 工具 + 复用 desktop 命令通道**（同步闭环，最终形态）

## 实现状态（2026-09-16）

**第 1 步（扩展侧 observed/检测）：已完成**

- `applyFeishuMarkdown` 返回结构化结果，不再返回 boolean
- 失败码：`TARGET_MOVED` / `NOT_FOCUSED` / `NOT_RENDERED` / `WRONG_TARGET` / `EDITOR_REJECTED` / `READ_ONLY` / `PAGE_CHANGED`
- `refuse()` 造值、`writeError()` 抛错（都带 code/hint/retryable/observed）、`observeBlock()` 记录块 id/kind/text/autoNumbered/styles
- `WRONG_TARGET` 检测：全文变了但**目标块本身**没变 → 说明 paste 落到了别处

**第 3 步（page_write 工具 + 同步闭环）：已完成并 E2E 验证**

- Host 用 `ctx.get('tools').register()` 注册 `page_write`（走 Cordis 工具服务，不是 `agentCtx.tools`）
- 新增状态：`activeSelections`（session→selection）、`recentSelection`（无 session 的兜底）、`applyPending`、`applyWaiters`
- 新增路由：`GET /v1/apply/pending?selectionId=`、`POST /v1/apply/result`
- 扩展：`background.js` 加两个 message 类型（**放在 document-busy 闸门之前**，因为它们在改写进行中到达）；
  `content.js` 在回合进行中轮询命令、执行、回报 outcome
- 技能新增 `## Writing to the page` 一节 + 完整错误码表 + 「没有 APPLIED 就不能宣称写入成功」

**E2E 实测**（假扩展替身 + 真实模型调用）：

```
模型调用 page_write → 入队 → /v1/apply/pending 取到 → 假扩展 POST /v1/apply/result
→ 工具 resolve → render() → 模型回答：code=APPLIED 落到 text #sim-1 …
```

**踩到的两个坑（已修）**：

1. 工具返回值里 `observed: null` 违反了自己声明的 `output.schema`（`observed` 是 object）
   → DSH 报 `tool "page_write" returned invalid output: "value.observed" must be an object`
   → 修法：`normalizeOutcome` 丢掉 null，工具自身失败路径不再返回 `observed: null`
2. 我的合成请求没带 `sessionId` → `activeSelections` 没登记 → 工具走 `NO_SELECTION`
   → 修法：加 `recentSelection` 兜底（扩展一次只驱动一个写入，唯一活跃选区是可靠回退）

**待办**：

- ⚠️ **真实扩展需要重新加载**才会开始轮询命令（`chrome://extensions`）
- `intent` / `format` 两个参数目前被忽略（扩展只写 text）—— 属于第 2 步的格式意图

## 真实用户会话暴露的 bug（2026-09-16）

用户在真实的 wiki 表格上试了一次，会话包 `<session-id>` 里可以看到：

```
选中: 表格单元格 (row2,col2)，mode=table-fill，instruction=「按照上面单元格的格式，补充这个格子的内容」
模型: page_write({text:"用户点击问答卡片跳转至详情页", intent:"replace-selection"})
结果: 已写入。 code=APPLIED 落到 text #69 "问答需新增卡片跳转详情页能力用户点击问答…"
                                                        ↑ 追加了，不是替换，而且没有分隔符
```

模型自己发现了：「The write appended rather than replaced... The code said APPLIED but it concatenated. That's wrong.」
然后它**转去用 MCP** 查文档结构——因为前端写入不可信。

### 两个真问题

1. **`intent` 被完全忽略**：`serveApplyCommands` 只传了 `text`。
   表单元格的纯文本 payload 落进 `applyFeishuMarkdown` 的 **caret 路径** → 光标处 paste → 追加
2. **`APPLIED` 报错了语义**：校验只检查「目标块变了没有」，追加也算变了

### 修复

- `replace(text, intent)` / `applyResult(text, intent)` / `applyFeishuMarkdown(md, pinned, intent)` 全链路透传 intent
- `intent:'replace-selection'` + **光标折叠**时（表格单元格、空段落就是这种），先 `selectLine(line)` 选中整行再 paste
  —— 这样才是「替换」而不是「追加」
- `table-fill` 的纯文本 payload **默认按 replace-selection 处理**（不再默默追加）
- 新增 `NOT_REPLACED` 码：写入后若「旧文本作为前缀保留且变长了」（追加特征），
  即使编辑器接受了 paste，也返回 `NOT_REPLACED` + 「改用 insert-at-caret，或先清空目标」
- 判定用 `startsWith + length>` 而不是 `includes`，避免「新文本恰好包含旧文本」误判

### 教训

「写入成功」有两个层次：**编辑器接受了** 和 **实现了意图**。只校验前者，模型就会拿着 `APPLIED` 去相信一件没发生的事。
错误码表因此增加 `NOT_REPLACED`。

## 第二次真实会话：两个独立问题（2026-09-16）

会话 `<session-id>` + Chrome 报错 `Uncaught (in promise) ReferenceError: pinned is not defined`

这次模型**做对了** —— 它按 table-fill 协议返回：

```json
{"operations":[{"type":"fill_cell","row":2,"col":2,
  "text":"用户在助手内点击问答卡片跳转至详情页"}],"fallback":"..."}
```

但 `generate()` 在收到回复后立刻抛错，**preview 和 auto-apply 全没执行** —— 所以用户看到「还是不对」。

### 根因

```js
async function generate(retry = false) {
  if (!anchor || busy() || applying || sessionWorking) return;
  ...
  const tableReply = pinned.mode === 'table-fill' && ...;   // ← pinned 从未声明
```

这是 `generate()` **信封/自动应用路径**上的一个潜伏 bug：只要改写成功返回，这一行就抛，
面板既不预览也不写入。（我无法确定它是何时引入的 —— 该文件没有备份；old panel 副本里还没有 table-fill 代码。）

### 修复

在 `generate()` 开头声明 `const pinned = anchor;`（与 `replace()` / `sessionAction()` 的既有写法一致），
语义上也正确：本轮属于哪个选区，必须在 `anchor` 可能被清空之前固定下来。

### 校验方法（这次学乖了）

写了个针对性静态检查：找出所有「用了 `pinned` 但没声明它」的函数。结果：

```
OK  refreshBinding / sessionAction / generate / replace   (local)
OK  tableFor / anchorLine / restoreSelection / applyFeishuMarkdown
OK  applyFeishuTableOps / applyMarkdownTable               (param)
```

10/10 全部正确。（泛化的「未声明标识符」扫描噪音过大 —— 会把对象字面量的属性值算进去 —— 不可用；
针对具体 bug 类做定向检查才有效。）

### 两个 bug 的关系

| 会话 | 模型行为 | 扩展行为 | 结果 |
| --- | --- | --- | --- |
| f12c84e7 | 调 `page_write(intent:'replace-selection')` | 忽略 intent，光标处 paste | **追加**，却报 `APPLIED` |
| 39e474fc | 返回正确的 `fill_cell` ops | `generate()` 抛 `pinned` | **什么都没写** |

一个是「写了但写错且报成功」，一个是「根本没写」。同一个目标：**模型不能拿到假信号**。

## 第三次会话：表格上下文错位（2026-09-16）

会话 `<session-id>`：用户说「按上面的格式，补充这个格子的内容」，模型却回了
`{"operations":[{"type":"fill_cell","row":2,"col":1,"text":"问答"}]}`。

### 根因一：Feishu 把表头和表体渲染成两个 `<table>`

```
table0 class="sticky-row-wrapper" rows=1 →时时间 |版本号 |负责人 |主要变更内容   ←表头
table1 class="table header-row" rows=1 →2026/09/11 | v1.0 |张三 |...       ←表体
```

`extractTableContext` 用 `closest('table')` 只拿到**表体**，所以报 `rows=3`（真实 4 行），
**表头凭空消失、行号整体偏移一格**。模型看到的是一张没有表头的表。

### 根因二：单元格只取第一行（格式被压平）

`data` 的提取是 `cell.querySelector('.ace-line')` —— **只取第一个 `.ace-line`**。
而真实数据是：

```
r1c2 = [2,12,12,12,12]  →  一句引导语 + 4 个 bullet
r2c2 = [2,12,12]        →  一句引导语 + 2 个 bullet
r3c2 = [2]              →  只有一句        ← 用户选中的格子
```

用户说的是「**按上面的格式**」，而模型连「上面」有 bullet 都看不到。

### 修复

1. 新增 `tableRowsOf(table)`：`.docx-table-inner-wrapper` 里找 `table.sticky-row-wrapper`，
   把它那一行**并到表体前面**。**读取和写入共用它** —— 否则模型按页面数出来的行号，写进去会错行。
2. 新增 `cellTextOf(cell)`：把单元格里每个 `[data-block-type]` 都取出来，
   bullet 标 `• `、ordered 标 `1. `、用换行连接 →**格式对模型可见了**。
3. `tableToMarkdown` 把单元格内的换行转成 `<br>`，不破坏 markdown 行结构。
4. `fillTableCell` / `applyMarkdownTable` 改用 `tableRowsOf`。
5. `structure.header` 字段告诉模型是否合并过表头。

### 实机验证

```
wrapperFound: true, stickyFound: true
bodyRows:1 + stickyRows:1 → mergedRows:2   ← MCP 查询确认该表确实是 2 行
headerCells: ["时时间","版本号","负责人","主要变更内容"]
```

###「没自动写入」的原因（重要）

模型回的是**信封（operations）**而不是调 `page_write`，而信封信封路径**只有在扩展选项里打开
auto-apply 时才自动写入**；`page_write` 不受该开关影响（它明确要求写入）。
第一次会话写了（用了 page_write），这次没写（用信封）—— 与证据一致。

已在技能里补：**表格也用 `page_write`**，把 operations JSON 当 `text` 传；
并说明行列下标 **0-based 且包含表头行**。

### 附带：webbridge 的坑

Feishu 文档是**内层容器滚动**，`window.scrollBy` 无效；且 bridge 对重 payload（30 次异步滚动循环）会超时。
可用的办法：先 `1+1` 探活，再用**极小 payload**（单次 querySelector + 一次计算）。

## 第四次会话：catch 吞掉执行错误（2026-09-16）

模型这次**完全看懂了**（它的 reasoning 准确复述了表头、行号、上面两格的 bullet 结构），
并正确调用 `page_write({text: <operations JSON>, intent:'replace-selection'})`。

结果却是：**整段 JSON 被当成普通文本写进了单元格**，而且工具回报 `code=APPLIED`。

### 根因：一个 catch 把「解析失败」和「执行失败」混在一起

```js
if (payload.startsWith('{')) {
  try {
    const parsed = JSON.parse(payload);
    if (parsed.operations && Array.isArray(parsed.operations)) {
      await applyFeishuTableOps(parsed.operations, pinned);
      return;
    }
  } catch (e) { /* 注释说：不是合法 JSON，往下走 */ }   ← applyFeishuTableOps 抛的错也被吞
}
```

`fill_cell` 执行失败 → 抛错 →被这个 catch 当成「不是 JSON」→落到 Markdown/纯文本路径
→**把整个信封原样 paste 进文档**→write 成功→`APPLIED`。

Chrome 里同时能看到 `applyFeishuTableOps` 的报错，就是因为两条路径都跑了。

### 修复

1. **解析与执行分离**：只有 `JSON.parse` 失败才「换下一种协议」；执行失败必须抛出。
   Markdown 表格分支同样处理（只有 `parseMarkdownTable` 返回 null 才 fall through）。
2. **`readCellText` 读整个单元格**（所有 block 用换行连接），不再只读第一个 `.ace-line`
   —— 之前多行写入必然「校验不符」，然后 fallback 用 `textContent` 把整段塞进第一行，造成重复。
3. **多行内容走 Markdown paste 路径**：把 `• ` 还原成 `- `，选中整个单元格后 paste，
   让编辑器把它变成真正的多个 block（assign textContent 会把换行全压平）。
4. 新增 `normalizeCell()`：比较时忽略 bullet 标记（`• x` / `- x` / `1. x` 等价）。

### 教训（第二次同类型）

**过度宽泛的 catch 会把「降级」变成「静默写错」**。降级只应在**解析阶段**发生，
执行阶段失败必须让上层看见 —— 否则就是给模型一个假的 `APPLIED`。

### 「已停止」的来源

`content.js:894` 的 `close()` 会调 `cancel()`，`cancel()` 发 `{type:'cancel'}` →Host 中止该轮。
会话记录里对应 `turn/end {reason:{kind:'aborted', reason:{kind:'user'}}}`。
**即：关掉面板 = 取消正在进行的任务**（点「取消」按钮同理，见 `content.js:2020`）。

### 文档污染与修复

r3c2 被写入了整段 JSON。已用 `doc_batch_update_text` 复原为「问答需新增卡片跳转详情页能力」。

## 第五次会话：「这个格子」指哪个（2026-09-16）

模型这次**没有写入**，而是给了一份「版本A /版本B」的文本让用户自己复制。它的 reasoning 说漏了：

> I need to create content for the **"示意图" (diagram/illustration) column** …
> Since all the diagram cells in the table are currently empty…

但 `currentCell` 是 `{row:3,col:2}` = **需求描述列**。它把「这」绑定到了错的列。

### 根因1：上下文只给了坐标，没给名字

`structure.currentCell` 是一个坐标，模型得自己 `data[row][col]` 去数；
而用户指令里的「这」是个指示代词，**payload 里没有任何东西可以绑定它**。

修复：`structure` 增加自描述字段

```json
{ "currentCell": {"row":3,"col":2},
  "currentCellAddress": "需求描述",                     // 列名
  "currentCellText":    "问答需新增卡片跳转详情页能力",   // 现在里面是什么
  "rowLabel":           "问答卡片跳转详情页" }        // 行首列
```

### 根因2（更严重）：table-fill 会把「回答」原样写进文档

```js
const tableReply = pinned.mode === 'table-fill' && pinned.pageContext?.type === 'table';
const envelope = tableReply ? null : parseEnvelope(reply.replacement);
//                  ↑ table-fill直接跳过信封校验
```

模型返回 `{"kind":"answer","text":"…"}` →被当作写入内容 →**整个回答被贴进单元格**，
r3c2一度变成 **30 个 block**。（已用 `doc_delete_blocks_by_ids` 删掉29个并还原文本。）

**这也说明 auto-apply 其实是开着的** —— 第四次会话我推测它没开，是错的。

### 修复

1. **table-fill 只接受三种写入**：operations JSON / Markdown表格 / **纯文本 =填选中的单元格**
2. 合法 JSON 但不是 operations → 抛 `NOT_A_WRITE`（提示「直接给单元格内容，别返回信封」），**绝不 paste**
3. **纯文本走入选中的单元格**，目标由 `currentCell` 决定 ——模型**不需要数行列**
4. 技能同步：说明 `currentCellAddress/Text/rowLabel`，「这」永远指它们；
   并明确 `page_write({ text: "引导句\n• 要点一" })` 就是该单元格的新内容（首行=段落，`• `行=bullet块）

### 又一次印证同一条教训

**默认路径不能靠「看起来像写入」来放行**。table-fill为了省掉信封校验而直接应用 `replacement`，
等价于把模型的任何输出都当成指令。要么显式匹配协议，要么拒绝。

## 带格式的内容怎么落地（2026-09-16）

### 分层现实

| 层 | 例子 | 现在能不能 |
| --- | --- | --- |
| Markdown 能表达的 | 加粗/斜体/删除线/行内代码/链接/列表/引用/代码块/分隔线 | ✅ 走 Feishu 自己的 Markdown 粘贴转换 |
| 前端引擎能写但 Markdown 表达不了的 | 字体颜色、高亮底色、高亮块 emoji/填充、seq 自动编号、分栏 | ⚠️ 原语已验证，但**尚未接进写入路径** |
| 单元格放不下的 | callout / grid 这类块级容器 | ❌ 在 cell 里无意义 |

### 刚修掉的漏洞：单行 Markdown 曾是字面文本

`fillTableCell` 之前这样分流：

```js
if (zone && text.includes('\n')) { /* 走 Markdown paste */ }
// 单行 → execCommand / textContent → 纯文本
```

所以单行的 `**重点**` 会原样显示成星号，只有多行内容才被转换 —— **同一份 Markdown，行为取决于有没有换行**。

改成：**所有单元格写入都先走 Markdown 粘贴**（编辑器解析它是唯一能产出真块级结构和行内样式的通道）；
纯文本路径降级为「粘贴完全没生效时」的兜底。并加了一条护栏：粘贴**生效了但结果不符**就报错，
不写第二次（否则会把内容重复一遍）。

### `format` 参数：设计上属于它，但现在被忽略

`page_write` 已经接受 `format`，但扩展**还没消费**。接法很自然（同一闭环）：

```js
page_write({ text: "...", format: { highlight: "yellow" } })   // 行内高亮
page_write({ text: "...", format: { color: "red" } })        // 字体颜色
page_write({ text: "标题", format: { autoNumber: true } })      // seq 自动编号
```

扩展侧在写完文本后，用已验证的原语套格式：重新选中刚写入的 range →
`execCommand('textHighlight'|'textHighlightBackground')` / `tx.replace(rec,['seq'],'auto')` /
`tx.replace(rec,['emoji_id'],...)`。

## format 参数：已实现并实机验证（2026-09-16）

### 架构：必须 MAIN 世界

颜色表和编辑器引擎都在页面自己的对象图里 —— 引擎藏在每个块的 React fiber 后面，颜色表在 webpack 模块里。
isolated content script 看不见（页面设的 expando 属性按 world 隔离），所以新增：

- `src/page-format.js`：MAIN 世界桥，由 `chrome.scripting.executeScript({world:'MAIN', files})` 按需注入，
  再用 `executeScript({func, args})` 调用 —— 结果直接返回，不需要 postMessage 管道
- `manifest.json` 加 `scripting` 权限；`background.js` 加 `format-apply` 消息类型

### 模块查找：按特征，不按 id

扫 `__W.m` 全部模块按导出形状匹配。踩到的坑：

1. 选择器表（`m.y.Text/Background`）和可读颜色名表（`m.CK`）在**两个不同的模块**里，
   最初用一个谓词同时找两者 → 两个都找不到
2. emoji 谓词 `m.A && m.A.getInstance` 命中 6 个，必须进一步校验实例方法
   （`getEmojiIdByNativeEmoji` + `getUnified`）才唯一命中
3. 匹配颜色要先按常量名匹配、再用常量值查 map —— 直接匹配 map 的 key 依赖它是字符串

实测命中：`642213`(y) / `331309`(CK) / `89625`(callout) / `454902`(emoji) / `661294`(dO,JI)

### 颜色名：红色其实叫 PINK

`COLOR_PINK_TEXT / ORANGE / YELLOW / GREEN / BLUE / PURPLE / GRAY / DEFAULT` —— **没有 COLOR_RED_TEXT**。
已加别名表 `{red:'PINK', grey:'GRAY', black:'DEFAULT'}`。

### 实机验证结果（全部通过）

| op | 返回 | 实测 |
| --- | --- | --- |
| highlight | `value: rgba(255,246,122,0.8)` | 背景色一致 ✅ |
| color | `value: rgb(216,57,49)` | 字体色一致 ✅ |
| autoNumber | ok | `heading-order` 按钮出现 ✅ |
| callout | fields: emoji_id/emoji_value/background_color/border_color | 📌 出现 ✅ |

### 失败语义

新增 `NOT_FORMATTED`：**文本已写入但格式没生效**。hint 明确要求「不要重复写入文本（会重复内容）」，
因为文本已经落地，重试整次写入会造成重复。

## 第六次会话：写了两遍，以及 hint 的 schema 坑（2026-09-16）

模型这次**第一次就写对了内容**（引导句 + 4 个 bullet，格式完全符合上面的格子）。但工具连续两次报：

```
Error: tool "page_write" returned invalid output: "value.hint" must be a string
```

### 根因：我只修了 observed，漏了 hint

@@output.schema@@ 声明 @@hint: {type:"string"}@@，但扩展失败时返回 @@hint: null@@ →
**输出校验失败 → 整个工具调用报错**。模型拿不到任何结果，只好重试一次 → **写了两次**。

这和之前 @@observed@@ 那个坑是同一类。修法相同：@@normalizeOutcome@@ 里丢掉 null（同时保留 @@observed@@ 的处理）。

**教训**：schema 里声明了可选字段，就必须保证「要么是合法类型，要么不存在」——
一条 @@null@@ 会让整个调用失败，比丢一个可选字段的代价大得多。

### 模型的表现其实是对的

它拿不到结果后没有谎报成功，而是明确说「写入没有成功…**并未落盘**，请不要认为已经改好」。
契约起作用了 —— 是桥报错了，不是模型不诚实。

### 仍未修：单元格是「追加」不是「替换」

单元格最终有 7 个 block（想要的 5 个 + 旧内容残留 + 一行被压平的拼接）。
原因是 Markdown 粘贴在**多 block 的单元格**里不能跨块替换，旧块会留下。
@@fillTableCell@@ 已有「粘贴生效但结果不符就报错、不写第二次」的护栏（所以一次调用内不会重复），
但跨调用仍会累积。**下一步**：写入前先用 MAIN 桥清空单元格的旧块（引擎级删除）。

本轮已修复文档：删掉被压平的拼接行和残留的旧块，保留引导句 + 4 个 bullet。

## 单元格替换：写入前先清空旧块（2026-09-16）

### 问题

Feishu 的粘贴**只替换它落点的那个块**，单元格里其它块原封不动 —— 往已有内容的单元格里写，
新块会追加在旧块后面，单元格读起来就是重复的。

### 方案

新增 MAIN 桥 op `removeBlocks`：按 block id 删块。**不需要未公开的 parent API** ——
从 `bm.getRootRecordId()` 出发 BFS 遍历 `bm.getRecord(id).snapshot.children` 找到拥有目标记录的父记录，
再 `tx.replace(parent,['children'], children.filter(id => id !== rec))`。

`fillTableCell` 在粘贴前删掉单元格里除第一个以外的所有块，于是写入从「追加」变成「替换」。

### 验证

- 失败路径 ✅ 实测：不存在的 id → `EDITOR_REJECTED` + 「找不到这个块」
- 成功路径：删除用的 `applyTransaction + tx.replace(parent,['children'],filtered)` 是本项目早已验证过的原语

### blockManager 可用 API（本轮探到的）

`@
getRootRecordId / getRecord / getRecordByBlockId / getBlockStructsByRecordId
getBlockIdsByRecordId / getBlockModelsByRecordId / getBlockViewsByRecordId / createSnapshot
getRecord(id) → { id, snapshot }   // snapshot.children = 子记录 id 数组
`@

## 目标模型（targetRef）—— 2026-09-17

### 问题：谁在判断「这是不是我要的」

之前的校验是**程序拿字符串比对**：

`@js
normalizeCell(实测文本) === normalizeCell(期望文本)   // 期望值来自输入
`@

**它在原理上就做不成** —— 这是在用输入去预测编辑器的渲染结果。文本投影的每一环
（源码 vs 渲染、标记剥离、行切分、重排、零宽字符、块 ID 重建）都可能不等，
**而这不等于写入失败**。这一整轮的反复失败，全部是它给出的假阴性。

| 现象 | 真实原因 |
| --- | --- |
| `**加粗**` 必然失败 | 期望值用源码，实际是渲染文本 |
| 上屏后立马被清除 | 假失败触发回滚，而回滚判据也错 |
| 模型绕圈 | 它每次都在追一个**程序虚构的**成功标准 |

**正确的分工**：程序只报能确证的事实（块 ID、每块现在的内容、是否变化），
**判断「这是不是我要的」属于模型** —— 它同时握着意图和实际内容。

改动：所有 `throw new Error(内容不符)` 改为 `return { matched, text }`，
并由 `verifiedBy` 如实标注验证程度（`text-match` / `observed-only`）。

### 目标抽象

`@
targetRef := 插件签发的不透明 token（120s 生存期）
  解析 → { kind: block, blockId }        单元格里的某一个块
        { kind: table-cell, row, col }   整个单元格
`@

| 规则 | 实现 |
| --- | --- |
| 只能插件签发 | `issueTarget()` —— 模型无法凭空造 |
| 读写共用解析 | `resolveTarget()` —— 不再各算各的 |
| 粒度可达块 | `blockTargetsIn(cell)` —— 单元格内每块独立 ref |
| 写后重新签发 | `observed.targetRef` —— 编辑器会换块 ID |
| 过期即失效 | 120s，超时 `TARGET_MOVED` 迫使重新读取 |

### 块级目标修掉的事故

用户说「给这一行加粗」，模型只发那一行；但当时工具的最小粒度是**整个单元格**，
所以 `page_edit` 把它理解为「替换整格」—— **其余内容被清理掉**。

`editBlock(target, text)`：只选中那一个块的行 → 粘贴。
**不读单元格、不比对整格、不触发单元格级清理。**

### 一条该早点立的规矩

**不可逆操作（删除 / 回滚）只有在判据被实机证明之后才能启用。**
这一轮同一个错误出现了三次，每次都配着一个「我当时觉得够精确」的判据：

1. 按意图文本猜块归属 → 删掉正确内容
2. 回滚按块 ID 差集判新增 → 编辑器换 ID，把正确结果全删
3. 校验按源码比对渲染 → 假失败

**删除是不可逆的；判据不准时，报错永远优于动手。**

## v2 编辑内核重构（2026-09-17）

### 为什么要重构

上一版的失败不是个别 bug，而是**同一份目标/操作/结果在不同路径里被各自重新解释**：

- page_read 报 bullet #72，写入却落到整个单元格；
- targetRef 在归一化和入队两处被丢掉，模型拿不到也用不上；
- 失效引用自动回退到当前选区，等于扩大修改范围；
- 清理旧块靠文字相等猜测归属，粘贴被消费时把原文删了；
- 编辑不返回 commandId，超时后的迟到结果无处可查。

### 现在的结构

`@
Host  page-tools.ts   三个工具，共用 shared/edit-protocol.cjs 校验
      page-broker.ts  queued→claimed→executing→completed/unknown 生命周期
扩展  background.js   按标签页/页面实例/任务令牌鉴权转发
      page-channel.js 领取→开始→执行→回报，回报失败只重发结果
      edit-core.js    目标注册表 + 按操作分发的适配器执行
      adapters        普通输入框 / 通用富文本 / 飞书模型范围
`@

### 四条硬约束

1. **失效引用不回退**：传了无效/过期 ref 直接 STALE_TARGET，绝不落到当前选区。
2. **操作显式**：set-format 只改属性、不接受 text；text 操作不接受 format；
   plain 原样写入，不解析 JSON/围栏/表格。操作类型不再由正文形状推断。
3. **目标绑定**：ref 绑定任务、页面实例、文档与内容 revision；写入前核对 revision。
4. **不重复执行**：命令有 commandId 与执行租约，重复 start 不重跑；
   回报丢失只重发结果，迟到结果仍被接受。

### 飞书改为模型范围编辑

不再粘贴+猜删，而是直接用编辑器内容状态：

- setAttributes(range, attrs) 改指定范围的布尔/颜色属性；
- replaceText(range, text) 改指定范围的文字；
- 写入后回读**模型层**，逐字符核对变化范围内外的文字与属性。

两个必须记住的坐标事实：

- .ace-line 的 textContent 带零宽空格（32 vs 模型 31），
  直接用 DOM 长度会全部被判 STALE_RANGE；必须按模型坐标换算。
- 布尔属性在模型里用字符串 true 表示，清除是写空串；
  写成 false 会变成既非真也非空、视觉上不生效的中间态。

### 能力上的诚实缩减

表格整格多块替换 **明确拒绝**（atomicCellReplacement:false）——
在没有原子事务之前不再用猜测式清理冒充完成。桌面交接同样停用。
