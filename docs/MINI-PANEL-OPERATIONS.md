# mini-panel 已验证操作（唯一权威清单）

本文档记录**实测过**的操作。凡未在此列出的机制，都是未验证的 —— 不要使用，也不要写进工具描述。
最后更新：本次会话（飞书编辑器构建 1.0.17.9977）

## 一、写入机制（唯一可用的一条）

**编辑器自己的键盘命令管线**。它是唯一被证明能改结构、且**不破坏同步**的路径。

```js
// 块结构类型（开关：再按一次即取消 —— 等价于工具栏按钮）
Cmd+Shift+7  有序列表      实测：type -> ordered ✓
Cmd+Shift+8  无序列表      实测：type -> bullet  ✓
Cmd+Opt+1..4 标题1-4       实测：type -> heading2 ✓
Cmd+Opt+0    正文
// 切分
Enter                     实测：块数 +1 ✓（需确认块数增加，否则重试）
```

**顺序纪律（每一条都是实测换来的）**
1. **先设类型，再写文字**。反了必坏（`execCommand('insertText')` 会扰动光标，其后发的快捷键落空）
2. **每一步都要确认效果**：切分确认块数增加；类型确认 `block.type` 变化；文字确认回读吻合
3. **清编号放在最后统一做**（放在每项之后会打断后续项的套用 —— 本次会话实测踩中过）
4. 清编号用**再按一次同一个快捷键**（开关），**不要用行首退格**（可能与前一块合并）

## 二、编号（seq）

- 编号**不是文字**，是块快照上的 **`record.snapshot.seq`**（`'auto'` 表示有编号）
- 页面渲染的数字来自 `getOrder()`（按大纲层级计算 → 会出现 11. / 4.3 这种）
- **取消编号**：对已编号的块**再按一次它的结构快捷键** 实测 `heading-order true -> false`，且标题类型保留 ✓
- **读取编号**：`record.snapshot.seq`，或 DOM 里的 `heading-order` 类
- 列表修改面板（模块 394703）只有 继续编号 / 开始新列表 / 重新编号，**没有"关闭"**

## 三、已证伪的路径（不要再用）

| 路径 | 实测结果 |
|---|---|
| 合成 `ClipboardEvent('paste')` | 能建块，但**绕过事务管线 → 页面与服务端不一致**（飞书要求"复制全文再刷新"）✗ |
| `editor.setHTML(html)` | **建不出块**（created 0）✗ |
| `execCommand('turn_into_*')` | 无效果（未到达命令分发）✗ |
| 手拼菜单 ctx（`organizeGroupList`）| 缺 selectionAPI（`getBoundary` on null）✗ |
| `applyTransaction('mini-panel:xxx')` | **自造的操作名不被接受** —— 删除失败两次、编号清除从未生效 ✗ |
| `applyTransaction('delete')` / `('replace')` | 操作名已修正，但**均未验证** ✗ |

## 四、定位与保护（已验证）

- 块类型**以编辑器模型为准**（DOM 的 `data-block-type` 把标题报成 `text` ✗）
- **标题不可写**：`recordId === blockManager.getRootRecordId()` → `UNSUPPORTED_TARGET` ✓
- **未挂载块不可写**：`NOT_MOUNTED` ✓
- **原子块**（callout/table/divider/quote_container）无 editor → `editable:false` ✓
- 光标**折叠且落在块内**即可（不必在 `.ace-line` 里）→ 否则 `OUTSIDE_EDITOR_TEXT` ✓
- 跨块选区 → `CROSS_BLOCK`（暂不支持）✓

## 五、失败上报（已验证）

- 逐项回读：任一项没落地 → `PARTIAL_STRUCTURE` + 指出是哪一项 ✓
- 无新块且锚点未变 → `NOT_RENDERED / not-modified`（**不能**说成"文档未变"）✓
- 返回值必须带 `snapshot`（缺了会让执行器读 `after.text.length` 抛空指针 ✗ 已修）
- 回读比对要**剥掉行首自动编号**（否则正确写入被误报为缺失 ✗ 已修）

## 六、部署

- 改 profile → **必须真实改动内容**（仅 `touch` 不足，实测无效 ✗）→ 等约 12-15 秒 → **用 `/v1/health` 的 `build` 标记确认** ✓
- 只有确认后才可以说"已部署"

## 七、诊断入口

- 扩展内部日志：页面主世界里 `window.__dshPanelLog`（挂在 window 上，**引擎重新注入也不丢**）✓
- 内容脚本侧的拒绝（如 `OUTSIDE_EDITOR_TEXT`）**到不了桥** → 由 `Fault` 记入 `PANEL_RING`，并随 `outcome.recent` 回传 ✓

## 八、光标监听：用通用层，别挖内部服务（本轮发现）

**结论：`document.selectionchange` 在飞书编辑器里有效，并且能从事件里解析出光标所在块。**

实测（把选区程序化地放到两个不同的块上）：

```
events: 4
sequence: ["Lu6ni6","Lu6ni6","UQPnVh","UQPnVh"]   ← 两次分别落在两个块上，能从 anchorNode 解出块 id
```

解析方法：`getSelection().anchorNode → closest('[data-record-id]')`（与 begin() 里已有的解析一致）。

**为什么之前没找到**：我去挖飞书内部的选区服务（菜单 ctx 里的 selectionAPI）和事件常量，方向错了。内部 eventEmitter 确实存在（addListener / removeListener / dispatch），但静态扫全 bundle 的字面量事件名里**没有**选区/光标事件（只有 VC_FOLLOW_HOVER、BEFORE_UNDO、MENU_TRIGGER_*、dragstart/dragend），运行时探针也证实选区变化不走它。

**一个踩过的坑**：用 element.click() 测试不会产生真实光标，selectionchange 不触发（我因此误判过一次"没有事件"）。要程序化设置选区，或者用真实的鼠标事件序列。

**对实现的用法**：发完聚焦后，等 selectionchange 报告光标落在目标块，超时才算失败；Enter 切分后同理等光标落到新块。这样就不再"睡 600 毫秒然后发键"，也不再依赖跨步骤残留的光标状态。

## 九、待回答的问题：什么该用通用层，什么该按网站适配

目前的判断（尚未系统验证，留作后续）：

**观察用通用层**
- 光标/选区：selectionchange、getSelection()、focusin/focusout
- 文本读取：textContent、Range
这些是只读的，用标准 API 不会破坏页面状态。

**改动只能走网站自己的管线**
- 改结构（标题/列表/切分）：编辑器自己的键盘命令管线。绕过它的写入已经出过事故——合成 ClipboardEvent(paste) 能建块，但页面与服务端不一致，飞书要求"复制全文再刷新"。

**身份与类型必须来自网站模型，不能信 DOM**
- 块 id / 类型 / 编号状态：以编辑器模型为准。反例：标题块在 DOM 上报 data-block-type="text"，模型里是 page，我据此把写入打到了文档标题上。

**尚未想清的部分**
- 通用层做观察的代价边界：selectionchange 触发频繁，需确认不拖慢页面；以及它是否只在文档选区变化时触发（若编辑器把焦点移进块外的隐藏输入，anchorNode 可能解析不到块）。
- ~~通用 execCommand(insertText) 是否绕过事务管线~~ **已验证：不绕过，能正常同步。** 做法：对空块用 insertText 写入标记，随后用飞书服务端接口按关键词搜该标记，命中（本地写入 PROBE-537803，服务端收到）。所以它和合成粘贴不是同一类问题——合成粘贴是在事务管线之外建块，才导致页面与服务端不一致。
- 适配层要薄到什么程度：现在每个机制都是"命令名 + 时序 + 校验"三件套，是否该收敛成一张声明表（能力 → 命令 → 前置/后置校验）。

## 十、已知未验证项

- 清编号挪到最后（hot52）：代码已改，**未端到端验证**
- hot52 的测试套件结果：本轮没看到输出，**未确认**
- applyTransaction(delete) / (replace)：操作名已改对，**均未验证**
- 行内 **加粗**：会被丢弃（明确限制，不假装支持）
