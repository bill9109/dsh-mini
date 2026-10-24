# 飞书前端内部引擎写入（2026-09-15 打通）

**结论：纯前端可以做到文字颜色 / 背景高亮，且真实落库**（已用飞书 API 独立回读确认）。
不走官方 API、不走 MCP、不需要任何额外凭据 —— 用的是页面自己的块引擎。

## 原理链

**1. 页面有两个 webpack 运行时**
`webpackChunk`（6350 模块，含 docx 编辑器）、`webpackChunk_ccme_web`（4358）。
push 进 chunk 数组即可拿到 require：

```js
window.webpackChunk.push([['x'],{},r=>window.__W=r])
```

**2. 块引擎对象不在全局**，要从 React fiber 取。React 版本是 legacy，
节点上的 key 是 `__reactInternalInstance$`（**不是** `__reactFiber$`）：

- `fiber.memoizedProps.recursionProps` → `selectionAPI` / `blockManager` / `undoModule` / `commentModule`
- `fiber.memoizedProps.model.editor` → 块引擎 editor（`execCommand` / `registerCommand` /
  `toggleAttribute` / `setInlineStyleOverride` / `getContentState` / `setContent`）
- `fiber.memoizedProps.editorAPI.modular` → 服务定位器

**3. 命令名 = 属性插件的 attributeKey**。`ed.pluginManager.Or` 是插件表：

```
19:Bold  20:Italic  21:Underline  22:Strikethrough  23:InlineCode
24:FontColor/textHighlight   25:BackgroundColor/textHighlightBackground
26,28:Link   29:CodeBlock  30:CodeHighlight
```

（源码里的 `fontcolor` / `backgroundcolor` 只是默认 fallback，活实例用的是 customized key。）

**4. 颜色的值不是原始 token**，要过转换表：

```js
var w=req(661294), D=req(642213), M=req(331309)
w.dO(D.y.Text).get(M.CK.COLOR_PINK_TEXT)                 // "rgb(216,57,49)"
w.dO(D.y.Background).get(M.CK.COLOR_YELLOW_LIGHT_BACKGROUND) // "rgba(255,246,122,0.8)"
```

文字色 8 种：PINK/ORANGE/YELLOW/GREEN/BLUE/PURPLE/GRAY/DEFAULT
背景 6 浅 + 6 深：`COLOR_*_LIGHT_BACKGROUND` / `COLOR_*_DARK_BACKGROUND`

## 最短可复现路径

```js
// 1) 拿 require
window.webpackChunk.push([['x'],{},r=>window.__W=r]);
var req=window.__W;

// 2) 拿引擎
function fiberOf(el){var k=Object.keys(el).find(k=>k.startsWith('__reactInternalInstance$'));return el[k]}
var f=fiberOf(document.querySelector('.zone-container')), fx={};
while(f&&!fx.ed){var p=f.memoizedProps;
 if(p){fx.rec=fx.rec||p.recursionProps; fx.ed=fx.ed||(p.model&&p.model.editor)}
 f=f.return}

// 3) 建立模型文本选区（不需要用户手势）
var line=document.querySelector('.zone-container .ace-line');
line.closest('.zone-container').focus();
fx.rec.selectionAPI.focus();
var r=document.createRange(); r.setStart(line.firstChild,0); r.setEnd(line.firstChild,4);
var s=getSelection(); s.removeAllRanges(); s.addRange(r);
await new Promise(res=>setTimeout(res,500));   // ← 必须等，让引擎同步模型选区

// 4) 上色
var w=req(661294),D=req(642213),M=req(331309);
fx.ed.execCommand('textHighlight',{value:w.dO(D.y.Text).get(M.CK.COLOR_PINK_TEXT)});
fx.ed.execCommand('textHighlightBackground',{value:w.dO(D.y.Background).get(M.CK.COLOR_YELLOW_LIGHT_BACKGROUND)});
```

## 已验证（API 独立回读）

| 操作 | 命令 | API 回读 |
| --- | --- | --- |
| 文字红色 | `textHighlight` = `rgb(216,57,49)` | `text_color:1` ✅ |
| 黄色背景 | `textHighlightBackground` | `background_color:3` ✅ |
| 文字蓝色 | `textHighlight` = `rgb(36,91,219)` | `text_color:5` ✅ |

## 产品化前必须知道的坑

1. **必须 MAIN world** —— 内容脚本默认在隔离世界，碰不到页面 `window`。
 需要 `world:"MAIN"`（MV3，Chrome 111+）。
2. **模块 id 会变** —— `661294`/`642213`/`331309` 是构建产物，每次发版都可能变，
 必须**按特征动态查找**（如"导出 `CK` 且值形如 `COLOR_*_TEXT` 的模块"）。
3. **未公开接口**，飞书随时可能改。
4. **选区要等** —— 设完 DOM Range 后必须等约 500ms 让引擎同步，否则命令没有目标（静默无效）。
5. **撤销栈未验证** —— 是否进 Cmd+Z 还没测。
6. **callout（高亮块）不是行内属性** —— 它是块类型（`type: CALLOUT` +
 `emoji_id/text_color/background_color/border_color`），需要走块插入 / 类型转换
 （`blockManager.applyTransaction`），**尚未尝试**。

## 顺带否定掉的路（省得再试）

- `[red]x[/red]` / `[bg:yellow]` / `::: callout` / `> [!NOTE]` 粘贴 → 全是字面文本
- `execCommand('foreColor'/'hiliteColor')` → 返回 true 但不上色，`hiliteColor` 还会删内容
- 带 `<span style="color:…">` 的 `text/html` 粘贴（含 Chrome 的 `<!--StartFragment-->` 封装）→ 样式被剥离
- 选中文字浮现的工具栏 → **合成指针事件被引擎整体忽略**，且 `isTrusted` 不可伪造

## 补充：布尔类属性 vs 颜色类属性（2026-09-15 续）

两者注册方式不同，**用错就静默无效**：

```js
// 颜色类（FontColor / BackgroundColor）：handler 读 e.value
r.registerCommand(key, function(e){ var n = e.value; r.toggleAttribute(key, n) })
//   → ed.execCommand('textHighlight', {value:'rgb(216,57,49)'})   ✅

// 布尔类（Bold / Italic / Underline / Strikethrough / InlineCode）：handler 无参数
o.registerCommand(n.KEY, function(){ o.toggleAttribute(n.KEY) })
//   → ed.execCommand('bold')      ❌ 静默无效
//   → ed.toggleAttribute('bold')  ✅ 必须直接调
```

### 已全部验证落库（API 独立回读）

| 属性 | 调用 | API 回读 |
| --- | --- | --- |
| 粗体 | `toggleAttribute('bold')` | `bold:true` ✅ |
| 斜体 | `toggleAttribute('italic')` | `italic:true` ✅ |
| 下划线 | `toggleAttribute('underline')` | `underline:true` ✅ |
| 删除线 | `toggleAttribute('strikethrough')` | `strikethrough:true` ✅ |
| 行内代码 | `toggleAttribute('inlineCode')` | `inline_code:true` ✅ |
| 文字色（8 种） | `execCommand('textHighlight',{value})` | `text_color:1..7` ✅ |
| 背景色（12 种） | `execCommand('textHighlightBackground',{value})` | `background_color:N` ✅ |

全部命令名（从 bundle 里 `.KEY="..."` 提取）：
`bold` `italic` `underline` `strikethrough` `inlineCode`
`fontcolor` `backgroundcolor` `textHighlight` `hyperlink` `linkToMentionId`

**Cmd+Z 有效**（用户实测）→ 走的是正规编辑事务，不是绕过编辑器的黑写。

## 块级（行前手柄那套）：入口已找到，尚未验证

```js
// 用一个 no-op 事务就能把事务对象的完整可变面捞出来
await blockManager.applyTransaction('probe', tx => { window.__TX = tx })

// tx 原型方法：
//   clear flush get insert remove replace create apply edit
//   createChildren insertChildren removeChildren replaceChildren saveAndApply

// 模型服务（挂在 editorAPI.modelService）：
//   getBlockModelByBlockId / createBlockModel / updateBlockModel / moveBlockModel

// 块类型枚举（req(858866).AI）：
//   TEXT ORDERED BULLET TASK TODO QUOTE QUOTE_CONTAINER PROGRESS
//   HEADING1..HEADING9 GRID_COLUMN DIVIDER CALLOUT CODE TABLE CELL IMAGE ...
```

推测用法（**未跑通，下次先验证签名**）：

```js
await blockManager.applyTransaction('x', tx => tx.edit(blockId, { type: AI.HEADING1 }))
```

## 运维注意

`kimi-webbridge` 守护进程（127.0.0.1:10086）会间歇性超时；连续两次失败时先等一会儿再重试。

## 块级续：真实分发路径已定位（2026-09-15 再续）

### 1. 工具栏命令全表（模块 612064 的 `Pk`）

```
turn_into_heading1 … turn_into_heading9        turn_into_bullet
turn_into_ordered      turn_into_todo          turn_into_quote_container
turn_into_code         turn_into_text          turn_into_callout     ← 高亮块
add_divider            new_page                select_all
bold  italic  underline  strikethrough  link  inlineCode
backspace  enter  shift_enter  tab  untab  arrow_up/down/left/right  shift_arrow_*  keydown
```

（模块 id 会漂移，按特征查找：导出含 `TURN_INTO-heading1` 的模块。）

### 2. 但 `execCommand('turn_into_heading1')` 无效

实测：命令被调用但块类型不变（`text#22` → `text#22`），块级和文本级选区都试过。
**说明工具栏的块类型菜单不走 `execCommand` 分发。**

### 3. 真实路径（来自文件里「slash callout」菜单项的 action）

```js
// blockManager.getBlockModelByBlockId(id) ✅ 已实测可用
var model = blockManager.getBlockModelByBlockId(blockId)

// 服务定位器：blockManager.modular.get(<serviceId>)
var svc = blockManager.modular.get(serviceId)
await svc.handleModelsTurnInto({
  models: [model],
  triggerKey: 'heading1' | 'callout' | 'bullet' | ...,
  knownContext: { toggle: false, useModelSelection: false },
})
```

出处：mod479662 的 slash 菜单 callout 项 ——
`const u = j.modular.get(E.B); await u.handleModelsTurnInto({models:[r.model...]})`

### 4. 卡在哪

`blockManager.modular` ✔ 存在；`getBlockModelByBlockId` ✔ 可用；
但 **serviceId 本身会漂移**：源码里写的 `req(949386).B` 现在解不出来（`reading 'desc'`）。
`modular.caches` / `bindings` 都不直接暴露实例，扫不到 `handleModelsTurnInto`。

**下一步（很具体）**：遍历 `req.m`，找"导出类且 `prototype.handleModelsTurnInto` 存在"的模块 id，
拿这个 id 去 `modular.get(id)`；若仍不行，就找 `modular.register` 的注册点看 id 来源。

### 5. 不要走的路（已否定）

`tx.edit(recordId, path, value)` —— 报 `numToAttrib`，它是**文本属性**通道（属性内联表），不是块类型；
路径必须是数组，传字符串报 `Missing path`。两次尝试都在事务内报错，**文档未变**（无副作用）。

## 块级打通（2026-09-15 三续）

### 机制

服务实例在 `blockManager.modular.caches` —— 它是一个 **Map（248 条）**：

```js
var mm = blockManager.modular
var svc = null
for (const [, v] of mm.caches) if (typeof v.handleModelsTurnInto === 'function') svc = v

var model = blockManager.getBlockModelByBlockId(blockId)
// 或：blockManager.getBlockIdsByRecordId(recordId)[0]
await svc.handleModelsTurnInto({
  models: [model],
  triggerKey: 'heading2',              // heading1..9 / bullet / ordered / todo / text …
  knownContext: { toggle: false },
})
```

### 实测结果（API 回读）

| triggerKey | 结果 |
| --- | --- |
| `heading1..9` | ✅ **就地转换**（【B】text → `block_type 4 = heading2`，API 确认） |
| `bullet` / `ordered` / `text` | ✅ 就地转换 |
| `callout` / `quote_container` / `task` / `synced_source` | ⚠️ 走 **special rule**，**新建块**而非改原块 |

### 为什么特殊类型不一样

`svc.ruleSet.specialTurnIntoActionRules` 有 4 条，handler 形如：

```js
{ type:'callout',         h: async (e,r) => { await g(e, {...r, updateSelection:false}, [], n, o) } }
{ type:'quote_container', h: async (e,r) => { await s(e, {...r, updateSelection:false}, [], n, o) } }
{ type:'task',            h: (e,o) => 1!==e.length ? Promise.resolve() : l(n.getBlockViewByBlockId(e[0].id), o, n) }
```

`e` = models 数组，`r` = knownContext。
对**已存在的 text 块**调 `triggerKey:'callout'` 实测 `text → text`（不改），但从历史记录看它会**插入一个空 callout 块**（docx 里确实出现了 `block_type 19`）。
工具栏「转为高亮块」大概率走的是 slash 菜单那条路径：先建块，再 turn into。

### 关键操作要点（都是踩过的）

1. `editorAPI.modular` 上只有 `meta` / `modular`；服务实例在 `blockManager.modular.caches` 的 **Map** 里。
2. **Map 不能用 `Object.keys` 扫** —— 我第一次就是这么栽的，返回空数组，误以为没有。
3. **DOM 会虚拟化**：视口外的块不在 DOM 里，用 DOM 判断转换结果会误报 `gone@@。**必须用 API 或模型读回。**
4. `execCommand('turn_into_heading1')` **无效** —— 块类型不走 `execCommand`，必须走 `handleModelsTurnInto`。
5. `tx.edit()` 是**文本属性**通道（报 `numToAttrib`），不是块类型。
6. 工具栏命令全表在模块 `612064` 的 `Pk` 里：`turn_into_heading1..9` / `turn_into_bullet` /
   `turn_into_ordered` / `turn_into_quote_container` / `turn_into_code` / `turn_into_callout` / `add_divider` 等。

### 未完成

- 「把**已有段落**转成 callout（而非新建）」还没找到正确上下文（`g(...)` 需要更完整的 ctx）
- 块插入位置 / 拖拽排序 / 删除 —— 未测

## 块类型就地转换：已打通（2026-09-15 四续）

### 正确的调用方式（不要再试 execCommand）

```js
// 1) 从服务定位器的 Map 里取出转换服务（不要用 Object.keys 扫，它是 Map）
var svc = null
for (const [, v] of blockManager.modular.caches) if (typeof v.handleTurnInto === 'function') svc = v

// 2) 调用
await svc.handleTurnInto({
  triggerKey: 'heading2',                        // heading1..9 / bullet / ordered / todo / text / callout / quote_container …
  knownContext: {},
  selObjects: [{ id: blockId, type: 'block' }],  // ← 必须显式传，否则用引擎自己的选区
})
```

**实测**：`text → heading2` ✅（API 回读 `block_type 4`）。
`heading1-9` / `bullet` / `ordered` / `text` 都是就地转换。

### 调用链（源码级）

工具栏点「转为标题」时：

```
triggerCommand('TURN_INTO-heading2', ctx)
 → cmd.handler(ctx)
 → { blockManager, selectionAPI, preventDefaultAndStopEventImmediate, extraInfo, collector } = ctx
 → blockManager.modular.get(sid).handleTurnInto({ triggerKey, knownContext, ...extraInfo })
```

`handleTurnInto(e)` 的真实签名：

```js
let { triggerKey, knownContext, selObjects = this.selectionAPI.getSelection() } = e
if (!this.isRuleConfigRegistered) return
// 需要块模块的 key 会先异步加载，最多 race 3 秒
await Promise.race([this.blockManager.editorAPI.moduleService.loadBlockModule(triggerKey), timeout(3000)])
const i = (0,f.el)(selObjects, this.blockManager)
const s = this.ruleSet.specialTurnIntoCases.find(e => e.cond(triggerKey))?.h
if (s) return await s({ extractModelsBySelection, fixOperateTargets }, knownContext, i)
const c = this.getTurnIntoTargetModelsWithTriggerKeyAndSelObjects(triggerKey, i)
if (!this.canDoEdit(c, triggerKey) || !this.canModelsDoTurnInto(c, triggerKey)) return   // ← 静默返回
await this.batchTurnInto(c, triggerKey, ...)
```

### callout / quote_container / task / synced_source：卡在一个 guard

`specialTurnIntoCases` 共 4 条：

```js
{ cond: e => e === AI.CALLOUT,
  h: async (e,r,c) => { const i = (0,s.A)(e,c,n); if ((0,y.FV)(i)) return g(i,r,c,n,o) } }
{ cond: e => e === AI.QUOTE_CONTAINER,
  h: async (e,r,c) => { const l = (e => { const {extractModelsBySelection:o, fixOperateTargets:r} = e; return r(o(n,!0),!0) })(e,c);
                        if ((0,i.$7)(l)) return s(l,r,c,n,o) } }
```

实测：把 `selObjects` 按 `block` / `text+range` / `cursor` / 模型 / block view 五种形态喂进去，
`(0,y.FV)(i)` **始终 false**，`g` 从未被调用。
**缺的不是机制，是前置条件**（很可能是「块必须为空」或「selObjects 要是 block view 形态」）。
返回 `undefined`（而不是 false）说明命令找到了、guard 没过。

### 另一条已验证的路：能建块，但会新建

```js
await svc2.handleModelsTurnInto({ models: [model], triggerKey: 'callout', knownContext: { toggle: false } })
```

对已有块**不改类型**，但会**插入一个新的空 callout 块**（docx 里确认出现 `block_type 19`）。
所以「插一个高亮块」现在可行；「把这段文字变成高亮块」还差上面那个 guard。

### 关于 triggerCommand 的 ctx

`triggerCommand(name, ctx)` 需要的 `ctx` 是 mod245642 里那个**未导出**的上下文类实例，
靠 `currentTargetViewFilterEmpty` / `currentTargetModelFilterEmpty` / `collector` 等 getter 工作。
手工构造 plain object 也能让 handler 跑通（补上 `preventDefaultAndStopEventImmediate` 和
`collector.setExtraData` 即可），但它最终就是调 `handleTurnInto` ——
所以**优先直接用 handleTurnInto，别绕 triggerCommand**。

## 块菜单能力面（2026-09-15 五续）

### 工具栏 / 块菜单全部命令（CmdNameMap，83 条）

```
结构类 turn_into_text | turn_into_heading1..9 | turn_into_ordered | turn_into_bullet | turn_into_todo
         turn_into_code | turn_into_quote_container | turn_into_callout | turn_into_task
         turn_into_synced_source | models_turn_into_command | add_divider | add_table | new_page
         collapse | expand
行内类 bold | italic | underline | strikethrough | link | inline_code | text_highlight
         text_align_left | text_align_center | text_align_right
编辑类 command_delete | command_backspace | command_enter | shift_enter | meta_enter | command_tab
         un_tab | backspace_word | delete_word | cut | copy | copy_selection_link | select_all
         command_save | command_find | command_replace | toggle_task
模式类 switch_to_edit_mode | switch_to_read_mode | switch_to_revision_mode
```

（`MODELS_TURN_INTO_COMMAND` 那条是把它收到的 `extraInfo` 直接透传给 `handleModelsTurnInto(extraInfo)`。）

### 事务对象的真实签名（官方源码）

```js
insert(e,n,o)            // e=recordGroup, n=index, o=node(s) → 在 index 处插入
remove(e,n)              // 移除子节点 n
replace(e,n,o)           // e=recordId, n=key, o=value → 替换字段值（如 ['type']）
create(e,n)              // e=factory 或 recordId, n={recordId} → 新建 record，返回 id
replaceChildren(e,n,o)   // 替换子节点列表，o 默认 DEFAULT_RECORD
get(e)                   // recordId → record
applyTransaction(name, tx => { ... })   // 整个事务
```

### callout 转换：guard 已完整读出，但仍未通过

`specialTurnIntoCases` 里 callout 那条：

```js
{ cond: e => e === AI.CALLOUT,
  h: async (e,r,c) => { const i = (0,s.A)(e,c,n); if ((0,y.FV)(i)) return g(i,r,c,n,o) } }
```

`(0,y.FV)` = 模块 **997151** 的 `F@@`：

```js
function F(e){ if(0===e.length) return false
  return !P((0,s.A)(e)) && (function(e){
    const n=new Set; let o=false
    return e.every(el => N(el) ? (o=true,true)
      : (!L(el) || (n.add(el.id), !(!el.parent || !n.has(el.parent.id)) || !B(el))))
      && (n.size>0 || o)
  })(e) }
```

即：要么有元素满足 `N(el)`，要么有元素的 `parent` 也在集合里。

**试过且全部返回 false（`ret=undefined`、块类型不变）**：
`[{id,type:'block'}]` / `text+range` / `cursor` / model / block view / **空块** / **父子对（quote_container + 内部块）**

→ 说明 `i` 的**形态**不对（它由**未导出**的 `(0,f.el)(selObjects, blockManager)` 生成），而不是选择条件不对。

**结论**：`TURN_INTO-callout` 大概率不是「把普通段落变高亮块」的入口。
**插入高亮块**（`handleModelsTurnInto({models, triggerKey:'callout'})`）已验证可用（新建块）。

### 运维

`webbridge_evaluate` 的 payload 过重会超时（实测：扫描 6000 个模块源码必然超时，最小 `1+1` 正常）。
排查顺序：先用 `1+1` 确认 bridge 活着，再缩小 payload。

## 块级操作全部打通（2026-09-15 六续）

### 删除（已验证）

```js
await blockManager.applyTransaction('delete', tx => {
  const children = tx.get(rootRecordId).get('children')
  tx.replace(rootRecordId, ['children'], children.filter(id => id !== targetRecordId))
})
```

实测 children 20→19，MCP 回读块消失。
**注意**：`tx.remove(parentRec, childRec)` 会报 `invalid / missing instruction in op` —— 用 replace children 更简单可靠。

### 排序（拖拽排序，已验证）

```js
await bm.applyTransaction('reorder', tx => {
  const list = tx.get(rootRec).get('children').slice()
  const i = list.indexOf(a), j = list.indexOf(b)
  list[i] = b; list[j] = a
  tx.replace(rootRec, ['children'], list)
})
```

实测两块互换（idx 4↔5），MCP 回读顺序确实变了（无序项二/嵌套项/无序项一）。

### 把一段文字变成高亮块（已验证）

**两步组合**：

```js
// ① 插入一个 callout（会新建块）
await svc.handleModelsTurnInto({ models: [m], triggerKey: 'callout', knownContext: { toggle: false } })

// ② 把目标块移进这个 callout
await bm.applyTransaction('into-callout', tx => {
  const list = tx.get(rootRec).get('children').slice()
  const i = list.indexOf(targetRec); if (i >= 0) list.splice(i, 1)
  tx.replace(rootRec, ['children'], list)
  const cc = tx.get(calloutRec).get('children').slice()
  tx.replace(calloutRec, ['children'], cc.concat([targetRec]))
})
```

MCP 文档树实测：

```
19 [callout] ""
  2 [text] "这是一段引用文字。"
```

### 为什么 TURN_INTO-callout 对普通段落不生效（已彻查到底）

callout 的规则 provider 是 **mod467872**，真实源码：

```js
specialTurnIntoCase: { cond: e => e === CALLOUT,
  h: async (e,r,c) => { const i = (0,s.A)(e,c,n); if ((0,y.FV)(i)) return g(i,r,c,n,o) } }
// s = o(632101)   y = o(997151)   n = blockManager
```

`s.A(e,n,o)` = `ne(n) ? n.map(x => o.getBlockModelByBlockId(x.id)) : e.fixOperateTargets(e.extractModelsBySelection(n,true), true)`
→ `i` 就是 **block model 数组**。

`y.FV` 的谓词（模块 997151）：

```js
N(e) = e.type === 'callout'                            // 已经是高亮块
L(e) = A4[e.type]                                      // 是"容器类"类型
B(e) = e.struct.findDescendant(x => !A4[x.type])       // 含非容器后代
P(e) = 已包含 callout / quote_container / progress

F(e){ e.every(el => N(el) ? true                       // 已是 callout → 通过
       : !L(el) ? true                                 // 非容器 → 通过但不计数
       : (n.add(el.id), parent 在集合里 || !B(el)))     // 容器 → 需父节点也在集合里
    && (n.size > 0 || o) }
```

→ **普通段落 `N`=false、`L`=false → n.size=0, o=false → guard 恒 false**。
这就是七种 selObjects 形态全部失败的真正原因 —— **不是形态问题，是这个入口本来就不面向普通块**。

**结论**：`TURN_INTO-callout` 是给「容器类块」用的；普通段落变高亮块要走**插入 + 移动**那两步。

## 高亮块样式（底色 / 边框色 / emoji）：已打通（2026-09-15 七续）

### 三个属性的来源

```js
var S = req(89625), w = req(661294)
// S.fn = { TextColor:'text_color', Border:'border_color', BackgroundColor:'background_color' }

// ① 底色：16 色（8 浅 + 8 深），值是 rgb() 字符串
var bgMap = w.JI(S.fn.BackgroundColor)          // Map
bgMap.get(S.Vy.LightBlue)                       // "rgb(240,244,255)"
// Vy 枚举：Default LightRed LightOrange LightYellow LightGreen LightBlue LightPurple LightNeutral
//           DarkGray DarkRed DarkOrange DarkYellow DarkGreen DarkBlue DarkPurple DarkNeutral

// ② 边框色：light / dark × 7 色
var bdMap = w.JI(S.fn.Border)
bdMap.light.get(S.Rh.Blue)                      // "rgb(186,206,253)"
// Rh 枚举：Default Red Orange Yellow Green Blue Purple Neutral

// ③ emoji：先用 native emoji 查 id，再用 id 查统一码点
var Em = req(454902).A.getInstance()
Em.getEmojiIdByNativeEmoji('📌')                 // "pushpin"
Em.getUnified('pushpin')                        // "1f4cc"   ← emoji_value 必须是这个
```

### 写入

```js
await bm.applyTransaction('callout-style', tx => {
  tx.replace(rec, ['background_color'], bgMap.get(S.Vy.LightBlue))   // rgb(240,244,255)
  tx.replace(rec, ['border_color'],     bdMap.light.get(S.Rh.Blue))  // rgb(186,206,253)
  tx.replace(rec, ['emoji_id'],         'pushpin')
  tx.replace(rec, ['emoji_value'],      '1f4cc')                     // ← 必须统一码点
})
```

### 实测（MCP API 回读 + 截图）

```
before: background_color=2  border_color=2  emoji_id="desert_island"
after:  background_color=5  border_color=5  emoji_id="pushpin"
```

截图确认：浅蓝底 + 蓝边框 + 📌 + 正文。

### 三个坑

1. **`background_color` 只接受 `rgb(...)`**，传 `rgba(...)` 会报 `String does not match pattern`。
   注意：**文本高亮的背景表**（`w.dO(D.y.Background)` + `CK.COLOR_*_BACKGROUND`）返回的是 rgba，**不能直接用于高亮块**；
   高亮块要用 `w.JI(fn.BackgroundColor)` + `Vy.Light*/Dark*`。
2. **`emoji_value` 必须是统一码点字符串**（如 `1f4cc`）。填 native emoji（📌）会让**整笔事务校验失败**，
   而且这个坏值会留在模型里，导致**之后每一笔事务都失败** —— 必须用 `Em.getUnified(id)` 修正。
3. 常用 emoji id：`pushpin`(📌) `round_pushpin`(📍) `bulb`(💡) `star`(⭐)
   `fire`(🔥) `white_check_mark`(✅) `exclamation`(❗) `paperclip`(📎)

## 插入块（`+` 菜单能力）：待办 / 任务 / 分栏（2026-09-15 九续）

### 先纠正一个细节

`+` 菜单里的「基础 / 常用」不是两个固定写死的分类，而是各 **provider 模块**导出的分组：

```js
{ name:'slash grid', type: MenuItemNormal | SubmenuItemWithComponent,
  extra: { behavior: uJ.InsertBlock },        // ← 行为标识
  blockType: AI.GRID, keywords: …, action: async(e,i,a)=>{…}, key: jK.Grid }

// 分组外壳：
[{ panelType:[H.Slash, H.Add],
   group: ({context,options}) => ({ key, groupName, children }),
   slashPriority: …, addPriority: … }]
```

面板类型枚举（模块 790625 的 `H`）：
`Add='add-panel'` `BlockMenu='block-panel'` `Slash='slash'` `MENTION='mention-panel'` …

### 两条可用的插入路径

**路径 A：转类型（对文本类块有效）—— 最简单**

```js
await svc.handleTurnInto({
  triggerKey: 'todo',                              // 待办（复选框）→ block_type 17
  knownContext: {},
  selObjects: [{ id: blockId, type: 'block' }],
})
```

已验证：`段落 → todo` ✅（文字保留，块类型变 17）。
`triggerKey:'task'` 也可用（会新建 `block_type 35` 的任务块）。

**路径 B：容器 / 嵌入块（分栏、表格块、思维导图…）—— 各自的 helper**

分栏（2 列）：

```js
var H = req(790625).H, grid = req(312413).l     // 模块 id 会漂移，按导出名动态查
var view = bm.getBlockViewByBlockId(blockId)
await grid({ blocks: [view], blockManager: bm, panelType: H.Add, columnNum: 2 })
```

实测（MCP 文档树）：

```
24 [grid] ""
  25 [grid_column] ""
    2 [text] ""            ← 2 列分栏
  25 [grid_column] ""
    2 [text] ""
```

给**已有分栏加一列**：
`(0,req(746583).mr)({blockManager, gridBlockId, columnIndex, transactionName:'addGridColumnBySlash', highlight:true})`

表格块：`(0,req(775046).o)({blocks, blockManager, mark, panelType, ranks:{row:2, col:3}})`

### 底层通用建块器（所有插入最终都走它）

```js
req(200060).Z = async ({ blocks, panelType, mark, focusType, isTurnIntoBlock, createDataCallback, … }) => …
```

它先用 `u.ww(blocks, panelType===H.BlockMenu)` 找到锚点块，算出插入位置
（`isCurrentLine ? position : position + 1`），再交给 `(0,a.e)({block, parentModel, position, …})` 真正建块。
**`createDataCallback` 负责构造新块的记录** —— 分栏就是用它拼出 2 个 `grid_column` 及其子文本块。

## `+` 菜单完整清单 + 通用调用法（2026-09-15 十续）

### ① 运行时枚举整份菜单

```js
var svc = null
for (const [, v] of blockManager.modular.caches) if (typeof v.organizeGroupList === 'function') svc = v

var groups = svc.organizeGroupList({
  context: { blockManager, blocks: [anchorView], selectionAPI, extraProps: {} },
  options: { panelType: 'add-panel' },
  panelType: 'add-panel',
})
// → [{ key, groupName, children: [{ name, text, type, blockType, key, action, … }] }]
```

分组外壳来自各 provider 模块（`{group: ({context,options}) => ({groupName, children}), addPriority}`），
`mod555775` 负责把它接进 `onOrganizeMenuItems` 钩子。
`req(160423).z` = `modular.get(serviceId).organizeGroupList(e)`。

### ② 通用调用法：直接调 item.action()

**实测有效** —— item 的闭包里已经持有 context（blockManager / selectionAPI / 锚点块），**不用传参**：

```js
var item = basic.children.find(c => c.name === 'slash divider')
await item.action()            // → 插入分隔线（实测 divider 1→2）
// 同理 heading1: 0→1
```

**这一条覆盖菜单里所有条目**（包括还没逐个逆向的图片 / 投票 / 日程 / 画板 / 思维导图…），
比给每个类型单独找 helper 通用得多。

### ③ 菜单全清单（本文档上下文）

```
基础（submenuItemWithFlattenItems，11 项）
  一级标题 heading1 / 二级标题 heading2 / 三级标题 heading3 / 四级标题 heading4
  有序列表 ordered / 无序列表 bullet / 任务 todo / 代码块 code
  同步块 synced_source / 分隔线 divider / 链接 link

常用（7）
  任务 todo / 图片 Image / 视频或文件 FileBlock / 分栏 Grid
  同步块 synced_source / 按钮 ButtonBlock / 公式 Equation

团队协作（7）
  人员 user / 群名片 chat_card / 云文档 mention_doc / 投票 poll
  日期提醒 reminder / 信息收集 Info Collector / 日程 calendar_event

绘图（5）      画板 / 思维导图 / 流程图 / UML 图（都是 whiteboard）/ 更多 DrawingMore
进阶（3）      网页卡片 bookmark / 订阅号文章 / 倒计时 Timer
文档小组件（4）目录导航 / 时间轴 / 文本绘图 / 更多小组件（都是 isv）
项目管理（2）  Jira jira_issue / 飞书项目 meego
应用连接（1）  内嵌网页 third content blocks
多维表格 / 数据 / AI：当前上下文为空
```

### ④ 已单独验证过的条目

| 条目 | 前端调用 | 状态 |
| --- | --- | --- |
| 任务（待办） | `handleTurnInto({triggerKey:'todo', selObjects})` | ✅ 落库 |
| 任务块 | `handleTurnInto({triggerKey:'task'})` | ✅ 新建 block_type 35 |
| 分栏 | `grid({blocks:[view], blockManager, panelType:H.Add, columnNum:2})` | ✅ 2 列 |
| 分隔线 | `item.action()` | ✅ |
| 一级标题 | `item.action()` | ✅ |
| 标题 / 列表 / 引用 / 代码 | `handleTurnInto({triggerKey})` | ✅ |

## 页面上下文管道：已打通（2026-09-16）

### 改了什么

1. `content.js` 的 `extractFeishuContext` 从「只有表格」扩展到**通用块上下文**：

```json
{
  "type": "block",
  "block":     { "kind": "heading2", "text": "...", "autoNumbered": true, "indent": 0 },
  "container": "body | quote_container | callout | grid_column | table_cell",
  "siblings":  { "before": [...], "after": [...] },
  "document":  { "headings": [{ "level": 2, "text": "...", "numbered": true }] },
  "styles":    { "bold": false, "italic": true, "strikethrough": false,
                 "underline": false, "color": "rgb(31, 35, 41)", "background": null }
}
```

数据全部来自 DOM：`data-block-type` = kind；最近的 `[data-block-type]` 祖先 = container；
`[class*=heading-order]` = autoNumbered（编辑器渲染的编号是按钮，不是文字）。page 块映射成 `body`。

2. `generate()` 的 payload 加上 `pageContext`；`background.js` 两处（stream / 非 stream）转发。
3. Host 的 `FEISHU_SKILL` 新增 `## 块上下文` 一节（原文写的是「只有 table 实现」）。

### 端到端验证（A/B，直连 Host）

```
WITH pageContext:    {"kind":"answer","text":"我收到的 pageContext.block.kind 是 **heading2**。"}
WITHOUT pageContext: {"kind":"answer","text":"没有上下文"}
```

**模型确实收到了上下文**，没有时也如实说没有。

### 工具暴露：已查清（回答「agentCtx.tools 没有 register」指什么）

`ctx.get('tools')` 是 **`ToolRuntime extends Service`**（@deepseek-ai/dsh-tools），原型上有：

```ts
register(definition: ToolDefinition): () => void     // 返回 disposer，可逆
```

**所以 Host 插件能注册工具**（走 Cordis 服务路径）。
之前说的「没有 register」指的是 `agentCtx.tools` —— 那是 **agent 会话配置对象**，
接口只有 `presentAs / restrict / guard`，与工具注册无关。

`ToolDefinition` 需要：`name / description / parameters / output（必需）/ execute(args, exec)`。

### 仍未做

- **写入结果不回传** —— 模型不知道这次写没写成功
- **格式意图表达（第 2 步）**：路 A = 扩展现有 envelope 加 `format` 字段（扩展侧执行，不需新工具）；
  路 B = 用 `ctx.get('tools').register()` 注册真工具（现确认可行）
