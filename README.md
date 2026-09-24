# dsh-session-vault · DSH 会话保管库

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/jr-create/dsh-session-vault)

**浏览、导出、导入，以及跨机器搬运** DeepSeek Harness（DSH）的会话。

一个 DSH 插件包：宿主端（Node）+ 浏览器端（设置页 UI）双面，外加 4 个模型工具，让 Agent 也能自己搬会话。

名字里的 **vault（保管库）** 取的是三件事：会话在这里被**看见**（完整清单 + 范围筛选）、被**取走**（导出成可移植归档）、被**放回**（从归档导入）。

> 参考实现：[MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager)（会话归档管理）。
> 本插件解决的是它的相邻问题：**会话的跨机器 / 跨版本搬运**，而不是本地归档。
>
> 曾用名 `dsh-session-export`——那个名字只说了三分之一的能力，所以改了。归档文件里的格式标记是 `dsh-session-archive`（**不是**插件名），旧的 `dsh-session-export` 标记仍可读取，你已有的归档不会失效。
>
> npm 上不叫 `dsh-session-vault`（已被一个无关插件占用），因此**通过 GitHub 直接分发**。仓库名与内部路由/数据目录仍用 vault 命名，二者互不影响。

---

## 它做什么

| 能力 | 说明 |
| --- | --- |
| **导出** | 勾选若干会话 → 打包成一个 `.dshsession` 归档；不勾选则导出全部 |
| **部分成功** | 个别会话读不出来时跳过并逐条报告原因，其余照常导出（全部失败才报错） |
| **导入** | 上传或选择一个 `.dshsession` → 通过 DSH 的持久化服务重新落库，并挂到工作区侧栏 |
| **迁移路径** | 导入时可指定新的工作区目录，把会话从 `D:\old\proj` 搬到 `/home/me/proj` |
| **ID 冲突** | 默认跳过已有会话；也可选择以新 ID 导入，两份都保留 |
| **预览** | `dryRun` 只输出计划，不写入任何东西 |
| **归档管理** | 列出、下载、查看内容、删除已导出的归档 |
| **清理会话** | 永久删除三类垃圾：未挂载且未归档的、已归档的未挂载的、以及**从未使用过的空壳会话**；先预览、需双重确认 |
| **模型工具** | `session_list` / `session_export` / `session_archive_inspect` / `session_import` / `session_delete` |

归档格式是 **gzip 压缩的 JSONL**，并且是**归一化**的：导出的是持久化服务返回的事件，而不是磁盘上的原始字节。因此归档能跨越 DSH 的会话格式代际，被更新版本的 DSH 导入。磁盘目录的逐字节备份是另一件事。

## 真实输出

`GET /api/dsh-session-vault/sessions`（回环 + 同源围栏内）返回的会话清单，节选自真实运行实例：

```json
{
  "ok": true,
  "sessions": [
    {
      "id": "session-362579c9-a7b3-4b2c-b2d7-d12934cc7192",
      "title": "创建DSH会话导入导出插件",
      "titleSource": "cache",
      "sizeBytes": 2305196,
      "archived": false,
      "mounted": true,
      "orphaned": false,
      "workspace": { "path": "D:\\BaiduSyncdisk\\person\\dsh-session-vault", "title": "dsh-session-vault" }
    }
  ]
}
```

模型工具的真实往返（导出 → 检查 → 导入 dry-run）在 `test/engine.test.mjs` 与 `test/plugin.test.mjs` 中逐条覆盖，`node --test` 共 **201 项测试，全部离线通过**。

---

## 安装

```bash
# 从 GitHub 安装（纯 JS，无构建步骤，因此不需要 prepare 脚本 / allowBuilds 授权）
dsh plugin --profile web add github:jr-create/dsh-session-vault

# 锁定到某个 commit（推荐：后续推送无法悄悄改变实际运行的内容）
dsh plugin --profile web add github:jr-create/dsh-session-vault#<sha>

# 或装 Release 里的预打包 tarball（同样无需构建）
dsh plugin --profile web add ./dsh-session-vault-0.1.0.tgz

# 本地开发（link 到你的源码目录）
dsh plugin --profile web add link:<你的源码目录>
```

装完重启 `dsh web`，打开 **设置 → 会话保管库**。

卸载：

```bash
dsh plugin --profile web remove dsh-session-vault
```

### ⚠️ 这个插件没有任何依赖，请保持这样

**不要把 `node_modules` 一起复制，也不要给它加 `dependencies` / `peerDependencies`。**

`dsh plugin add link:<path>` 装出来的插件，是从**你链接的那个目录**被 import 的。Node 解析它内部的裸模块名（`@deepseek-ai/...`）时，是从**它自己的真实路径**逐级向上找 `node_modules`——而链接目录可能在 `D:\src`、`C:\Users\me\Downloads` 等任何地方，这些位置**不在 `~/.dsh/profiles/**` 下**，也就是够不到 harness 自己的依赖闭包。

后果不是"某个功能不可用"，是**整个插件树加载失败、`dsh web` 直接起不来**：

```
Error: dsh: plugin tree failed to load: ...
  Cannot find package '@deepseek-ai/dsh-tools'
  imported from D:\...\dsh-session-vault\lib\index.js
```

所以本插件**不 import 任何宿主包**：

| 原本要 import 的 | 现在 |
| --- | --- |
| 宿主服务（`sessionPersistence` / `workspaceRegistry` / `webServer` / `tools`） | 一律走 `ctx.get()` / `ctx.inject()`，**本来就不需要 import** |
| `@deepseek-ai/dsh-tools`（`defineTool`） | `lib/tool-schema.js`，本地实现，输出与宿主逐字段一致（有对照测试） |
| `@deepseek-ai/dsh-home-paths` | `lib/home.js`，本地实现（`$DSH_HOME` → `~/.dsh` 这条规则是稳定契约） |

`test/packaging.test.mjs` 会**真的去 import 每个模块**（在没有任何 `node_modules` 的前提下）来强制这条约束——一旦有人重新引入宿主 import，测试当场就会以 `ERR_MODULE_NOT_FOUND` 失败，而不是等到用户机器上 `dsh web` 起不来。

> `package.json` 里的 `dsh.client.inject` 是**另一回事**，必须保留：那是给宿主 `client-modules` 服务读的浏览器模块图声明，不是 Node import。

---

## 使用

### 图形界面

设置面板分四个标签页：

- **导出** —— 搜索、勾选、`导出所选并下载`。归档写入 `<DSH_HOME>/dsh-session-vault/exports/` 并直接下载到浏览器。
- **导入** —— 点击或拖入 `.dshsession`；面板会先列出归档内容。可填新的工作区目录、选择冲突策略、勾选是否自动建目录，再 `预览` 或 `开始导入`。
- **归档** —— 已导出的归档列表，支持下载 / 导入 / 删除。
- **清理** —— 三类垃圾各一个范围标签：**可清理**（未挂载且未归档）、**已归档的未挂载**（默认折叠，因为归档常常已是唯一的副本）、**空壳会话（从未使用）**（创建过但一句对话都没有）。计数始终可见，点标签切换。先 `预览`，再勾选「我明白」才能启用删除，最后还会再弹一次确认。空列表时也会把折叠起来的范围和数量一并说出来，不会因为"藏起来了"就看不到出路。

### 会话标题是怎么来的

面板里的标题按**三档**解析，每行还会标出来源是哪一档：

1. **投影缓存**（`titleSource: 'cache'`）—— 宿主已经算好的标题，最便宜。
2. **会话自己的第一条人类消息**（`titleSource: 'first-prompt'`）—— 缓存只覆盖**本进程投影过**的会话，所以"缓存没命中"是常态而不是异常：换了进程、换了机器、或者会话本来就没被投影过，缓存里都没有。这时才去打开日志，取第一条 `user/message` 且 `source.kind === 'user'` 的事件（注入的上下文也是 `user/message`，但 `kind` 是 `plugin`，不能拿来当标题），截断到 **5 个词 / 40 个 UTF-8 字节**，并先剥掉转义序列、控制字符和方向标记——第一条 prompt 是不可信文本，原样显示可能改写终端标题或让这一行看起来是别的意思。这一档只扫前 32 个事件、一次列表最多扫 128 个会话、最多并发打开 4 个日志，剩下的宁可不显示也不让面板等几百次解码。
3. **都没有**（`titleSource: null`）—— 显示「（无标题）」。

事件数（`eventCount`）在列表里**恒为 null**：`sessionPersistence.list()` 只给 `sizeBytes`，而数事件要解压整份日志，列表页不该做这件事。所以面板这一列是省略而不是显示一个错的数字——真实事件数只在日志本来就被打开的地方才有（导出结果、归档检查）。

### 「已存储的会话」≠「侧栏里的会话」

这是最容易让人误会的地方，所以面板顶部有一个**筛选器**把这些数直接报出来：

| 筛选 | 含义 |
| --- | --- |
| 全部 | `sessionPersistence` 里所有会话日志 |
| 侧栏可见 | 属于某个工作区，侧栏里看得到 |
| 未挂载工作区 | 日志还在磁盘上，但不属于任何工作区（与「清理」标签页的口径一致：两个视图都不认领，才叫未挂载） |
| 子代理 | `origin: 'subagent'` 的子会话，侧栏本来就不显示 |

**为什么会有「未挂载」的？** 两种常见的：

1. **删除了工作区。** DSH 删除工作区是**只注销工作区、明确保留每一个会话日志**（这是它的文档行为）。工作区没了，它的会话就从侧栏消失，但日志仍在磁盘上——于是本插件还列得出来。看起来就像"删了还在"。
2. **子代理会话。** 它们有日志、没有工作区归属，侧栏也不显示。

本插件**不会**因为它们不在侧栏就把它们藏起来——那些日志恰恰是最值得抢救的东西（比如工作区被误删）。它做的是把差异**标出来**：每行带 `未挂载工作区` / `子代理` 徽章，顶部报四个计数，并且可以按范围筛选、按范围导出。

要**真正**移除它们，得删掉会话本身（删工作区不够）。本插件现在提供这个操作——`清理` 标签页，或 `session_delete` 工具——但它是整个插件里**唯一**绕过服务直接动文件的动作，因为 `SessionPersistence` 根本没有删除接口。

这是对早期版本的**反转**：这里原本写的是"本插件故意不提供删除"。反转的理由是，那些日志会永远留在磁盘上、没有任何出路，而"彻底没有出路"并不比"有出口但加围栏"更安全——尤其当其中一个会话已经大到 1 MB 且 DSH 自己都读不出来时。围栏是：

- 只接受**没有工作区认领**的会话；**已归档的还要额外显式 opt-in**（`includeArchived`），因为归档的存在就是为了能恢复，默认把它变成"可删除"等于把那条退路也删掉。工作区归属同时看注册表的校验视图和 `workspace.json` 的持久账本，**取并集**——注册表会把读不出头部的会话从 `sessionIds` 里过滤掉，只看它就可能误判；反过来，注册表的视图要等它启动时建好 canonical-cwd 索引才有内容，所以标签也用账本补上，并标出是哪一个视图认领的（`workspaceClaim: 'registry' | 'ledger'`）。
- **空壳会话是另一类，需要另一个 opt-in**（`includeEmpty`）：它是**已挂载**的，只是日志里没有任何对话。这比删除孤儿更宽——一个工作区名下的会话本来绝不可删——所以它的门槛也更高：只有在宿主**读过日志并确认里面没有一条对话**（`conversation === false`）时才会放行。**日志读不出来导致的"不知道"永远不算放行**，那种情况仍然按"挂载中"拒绝。
- **正在运行的会话拒绝删除。** 在打开着的写句柄下面删日志是损坏，不是回收。查询活动会话时如果存储服务自己抛错，也按"可能活着"拒绝。
- 目录名由 id 经 **DSH 自己的段编码器**重新推出（`.`/`..`、分隔符、盘符、NUL 全部转义），再证明结果严格位于 sessions 根之内，所以任何构造出来的 id 都指不到别处。
- 真正删除必须显式 `confirm: true`；界面另外要求勾选"我明白删除不可撤销"并再弹一次确认。三道都过才动手。

删除会一并清掉投影缓存条目和（如果可达）`dsh-spill` 的溢出文件。**不会**生成归档——想留就先导出。

删除后会重新读一次会话列表，实测哪些 id 仍在被当前进程列出（`survivors`）。正常情况下是空的：`sessionPersistence.list()` 会重新扫描磁盘，所以删掉的会话立刻从列表消失，**不需要重启**。只有服务把列表缓存住时才会报出来，并明确告诉你重启 dsh 即可清除。

### 模型工具

Agent 可以直接调用：

```
session_list                 列出所有已存储会话（orphansOnly 只列可删除的；unmountedOnly 列所有没人认领的，含已归档）
session_export               导出到 .dshsession
session_archive_inspect      查看归档内容（只读）
session_import               从归档导入
session_delete               永久删除孤儿 / 空壳会话（先 dryRun，再 confirm: true；
                             includeArchived 删已归档的，includeEmpty 删从未使用的）
```

### HTTP 接口

浏览器端走 `/api/dsh-session-vault/*`：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/status` | 插件版本、目录、宿主服务可用性 |
| GET | `/sessions` | 会话列表（每项带 `mounted` / `orphaned` / `workspaceClaim` / `titleSource`） |
| GET | `/orphans` | 可清理的会话及可回收字节数；`?includeArchived=1` 带上已归档的，`?includeEmpty=1` 带上从未使用的；`unmountedCount` / `archivedCount` / `emptyCount` 三个计数**不受筛选影响**，永远报告真实总量 |
| GET | `/archives` | 已导出的归档列表 |
| POST | `/export` | `{ ids, fileName? }` → 生成归档 |
| GET | `/download?file=` | 下载归档 |
| POST | `/upload?name=` | 上传归档（原始字节） |
| POST | `/inspect` | `{ file }` → 归档内容 |
| POST | `/import` | `{ file, workspacePath?, mode?, dryRun? }` |
| POST | `/purge` | `{ ids, dryRun?, confirm?, includeArchived?, includeEmpty? }` → 删除孤儿或空壳会话 |
| POST | `/delete` | `{ file, confirm: true }` |

---

## 设计取舍

**走服务，不走文件。** 导出/导入全部通过 `ctx.sessionPersistence` 与 `ctx.workspaceRegistry` 完成，插件自己不写 `~/.dsh/sessions/**`，也不改 `workspace.json`。手写这些意味着要重新实现 `projectKey` 目录编码、会话格式代次文件名、跨进程写租约和工作区域写入链——任何一处写错都会损坏会话日志。这些都由服务负责，插件只负责塑形数据。

**流式，不整体加载。** 归档按记录读写：导出一次只打开一个会话句柄，导入一次只缓冲一个会话的事件。几百 MB 的会话日志不需要在堆里放大两份。

**不覆盖已有会话。** `SessionPersistence` 没有删除接口，所以本插件不提供覆盖：ID 冲突时要么跳过，要么以新 ID 导入。两条路都不丢数据。想要"替换"，可以先以新 ID 导入、再用归档管理插件删掉旧的。

**一个会话失败不拖垮整包。** 导入逐会话隔离，失败记入 `failed` 并继续，部分可恢复的归档尽量恢复。

**单会话读取句柄是资源。** 导出时逐个打开、逐个关闭，占用与会话数无关、只与单个会话大小有关。

**用 `ctx.inject` 等晚到的服务，不要用裸 `ctx.get`。** 这是实际踩到的坑，值得单独说：

`tools` 和 `webServer` 由别的 bundle 按自己的节奏发布。在 `apply` 执行的那一刻，`ctx.get('tools')` / `ctx.get('webServer')` 很可能还是 `undefined`——于是插件**静默地什么都没贡献**：没有工具、没有路由。更糟的是浏览器端照样会加载（`dsh-client-modules` 只读 package.json 里的 `dsh.client`），设置页正常渲染，然后每个请求都落到 `/api` RPC 通道的信任围栏上，拿到一个纯文本 `401 unauthorized`——前端显示的就是「服务端返回了无法解析的响应」。

正确写法是让 Cordis 把注册推迟到服务真正存在时：

```js
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register(route), 'label')
})
```

`test/plugin.test.mjs` 里的 `deferredContext()` 专门复现这个时序，并有 5 个回归测试锁住它（先发布 `webServer` 还是先发布 `tools` 都必须挂上）。

**一个会话读不出来，不该拖垮整包导出。** `list()` 会痛快地列出某个会话，而 `open()` 之后才拒绝它——真实例子是老的 v0 归档（`session.jsonl.zstd`）里有个 subagent 描述符版本 v0→v1 迁移不支持。这时导出会跳过它、把原因记进 `failed` 交回给用户，其余会话照常写入归档。全部失败才抛错（并且删掉那个只写了头的空归档，免得看起来像"成功导出了 0 个会话"）。自动命名也会按**实际写入数**重命名，避免留下一个叫 `6-sessions` 却只装了 5 个的归档。

**主题颜色必须成对使用，而且要给 fallback。** 也是踩过的坑：

- `var(--dsw-xxx)` 在令牌缺失时**整条声明失效**，回落到初始值——不会报错，只会画出你没想要的样子。所以本插件的每个主题引用都写成 `var(--dsw-alias-x, <字面量>)`。
- `--dsw-alias-brand-primary` 在**深色主题下是白色**。把品牌色背景和写死的 `color:#fff` 配在一起，就是白底白字——按钮整个"消失"。正确的搭档是 `--dsw-alias-label-primary-foreground`（DSH 自己就是这么用的）。`test/client.test.mjs` 的 `stylesheet contract` 用 4 条断言锁死这两点，包括"任何 `var(--dsw-*)` 都必须有 fallback"。

**「刷新」不能把正在用的面板卸载掉。** 第三个坑，也是最隐蔽的一个：

导入面板里，上传完归档会回调去刷新归档列表。而 `reload()` 会把 `loading` 置真，面板又是 `!loading && tab === 'import'` 这样挂载的——于是刷新**把刚刚收到文件的那个面板卸载了**，面板里的 `file` 状态随之销毁，重新挂载后回到"未选择"。用户看到的就是「拖进去，毫无反应」。

为什么**只有本机能用**：本机有已导出的归档，所以"或选择本机已有的归档"下拉框会渲染，从下拉框选择走的是 `setFile`，不触发刷新，于是不卸载。而**空机器上没有任何归档 → 下拉框根本不渲染 → 唯一入口就是拖拽/选择文件 → 必然命中这个 bug**。

两处修：

1. 面板只在**首次加载完成**（`ready`）前才让位给 loading，后台刷新不再卸载任何东西。这同时修掉了另外两个同源问题——导入完成后结果表格会被抹掉、部分导出成功的警告会瞬间消失。
2. 选中的归档由 section 持有（受控 props），而不是面板内部 state。这样无论因为什么重新挂载，选择都不会丢。

顺带修掉同一流程里另外两处"静默失败"：文件输入框上的 `accept=".dshsession"` 会让浏览器**把不匹配的文件置灰**（重命名过的归档根本选不中），已去掉；以及 `/archives` 只扫 `exports/` 不扫 `uploads/`，导致拖进来的归档不进列表、空机器上下拉框永远不出现。

这个插件没有 React/DOM 依赖（正是为了不再引入 `node_modules`），所以这些**无法做渲染测试**。`test/client.test.mjs` 里的 `import flow structure` 是四条**结构性断言**，替代渲染测试守住这一个生命周期缺陷——测试注释里写明了这个局限，没有假装它做得更多。

---

## 安全边界

- 所有 HTTP 路由都带 **仅回环 + 同源** 信任围栏（`isLoopbackRequest`）：对局域网暴露的部署不会服务这些端点，其他源的页面也无法通过用户浏览器驱动它们。
- 浏览器端**只能**引用插件自己暂存目录（`<DSH_HOME>/dsh-session-vault/{exports,uploads}`）里的文件名。文件名必须是裸文件名，含分隔符、盘符或 `..` 一律拒绝，因此恶意请求无法逃出插件目录。
- 只有模型工具接受任意绝对路径，而那是在 Agent 自身的审批策略下运行的。
- 归档内容包含完整会话记录（可能有敏感信息），请自行妥善保管。
- **`/purge` 是整个插件唯一绕过服务、直接写 `<DSH_HOME>/sessions` 的路径**，而且只做删除。它的围栏写在上面「未挂载工作区」一节和 `lib/engine.js` 的模块注释里：只允许孤儿会话（已归档的要 `includeArchived`）、空壳会话要 `includeEmpty` 且必须由读日志**证明确无对话**、拒绝在跑的会话、目录名经 DSH 自己的编码器重新推出并证明落在 sessions 根之内、且必须 `confirm: true`。测试里单独把 `DSH_HOME` 指向临时目录，所以一个测试用的假 id 即使和真实会话撞名，也不可能删到真实数据。

---

## 归档格式

`.dshsession` = gzip 流，内容是 NDJSON，一行一条记录：

```
{"type":"header", ...}    恰好一条，在开头   —— 格式、版本、生成器、来源
{"type":"session", ...}   每个会话一条       —— 头部、血缘、工作区、标题
{"type":"event", ...}     零到多条           —— 一个会话事件，按 seq 顺序
{"type":"session-end", ...} 每个会话一条     —— 事件计数校验
{"type":"footer", ...}    恰好一条，在结尾   —— 总数校验
```

读取端会校验：格式标记、版本号、每条 `session-end` 的计数、footer 与实际读到的总数。格式不符或计数不符都会明确报错，而不是静默导入半个归档。

未知记录类型会被跳过，所以更新版本写出的归档仍能被本版本读取（前向兼容）。

---

## 开发

```bash
node --test          # 201 个测试，全部离线，不需要 DSH 在运行
```

测试覆盖：

| 文件 | 覆盖 |
| --- | --- |
| `test/engine.test.mjs` | 归档读写、导出/导入全流程、冲突策略、路径重映射、dry run、单会话失败隔离；**孤儿判定与删除的每一道围栏**（占用/归档/在跑/越界/未确认/预览）、已归档的 opt-in、归属标注、**标题三档解析**（缓存 / 首条人类消息 / 无），以及 id 段编码器 |
| `test/plugin.test.mjs` | 注册 5 个工具、参数校验、工具级往返、`session_delete` 的确认要求、`ctx.inject` 晚到服务的时序 |
| `test/tool-schema.test.mjs` | 本地 schema 编译器与宿主 `defineTool` 的**逐字段对照**（fixture 由宿主真实产出） |
| `test/http.test.mjs` | 回环/同源围栏、文件名限制（含目录穿越）、HTTP 全链路往返、`/orphans`（含 `includeArchived` 与 `includeEmpty`）与 `/purge` |
| `test/client.test.mjs` | 在 `vm` 里复现模块加载器契约、bundle id、插槽注册、样式契约；**浏览器端调用的每个路由都必须在宿主端真实注册** |
| `test/packaging.test.mjs` | 无 `node_modules`、无依赖声明、每个模块都能独立 import |

宿主端测试不需要 DSH 运行：engine 只和 Cordis 服务对话，所以可以用内存假的
`sessionPersistence` / `workspaceRegistry` 完整驱动。

**凡是会写到 `DSH_HOME` 的测试，都把 `DSH_HOME` 指向临时目录**——`engine`、`http`、
`plugin` 三个文件都这么做。删除是真实的 `rm`，所以这条不是谨慎，而是硬性要求：
没有它，一个测试用的假 id 一旦和真实会话撞名，就会真的删掉用户的数据。

### 验证插件真的挂上了

```bash
dsh --profile web --dump-config | Select-String -Pattern "session-vault" -Context 1,1
```

`--dump-config` 只组合 profile 树然后退出，不启动服务：

```yaml
# == dsh-session-vault
- id: session-vault
  name: dsh-session-vault
```

但**组合成功 ≠ 加载成功**。要确认宿主端真的挂上，起一个临时实例再打它的接口：

```bash
dsh web --port 0 --no-open          # 输出一行带 token 的 URL
curl http://127.0.0.1:<port>/api/dsh-session-vault/status
```

返回 `{"ok":true,...}` 才算真的挂上了。返回 `401 unauthorized` 说明路由没注册——那正是宿主端没加载的症状。

## 源码结构

```
lib/archive.js      归档格式的读写（流式）
lib/engine.js       会话发现 / 导出 / 导入 / 孤儿判定 / 删除 / 归档检查
lib/http.js         /api/dsh-session-vault/* 路由族
lib/home.js         $DSH_HOME 解析（替代 @deepseek-ai/dsh-home-paths）
lib/tool-schema.js  defineTool 的本地实现（替代 @deepseek-ai/dsh-tools）
lib/index.js        宿主端插件入口：路由 + 模型工具
lib/client.js       浏览器端：window.__ModuleLoader__ 工厂 + 设置页 UI
```

浏览器端是**手写**的，没有打包步骤——它直接按 DSH `client-modules` 期望的格式注册一个惰性 CommonJS 工厂，React 通过工厂的 `require` 拿到。

---

## 生效方式

插件已装入 `web` profile。宿主端在启动时装载，所以**需要重启 `dsh web`** 才能在设置里看到「会话保管库」并让 5 个模型工具可用。

```bash
dsh web
```

## 兼容性与权限

| 项 | 值 |
| --- | --- |
| 安装命令 | `dsh plugin --profile web add github:jr-create/dsh-session-vault` |
| 目标 profile | `web`（宿主端服务任意 profile 可用；设置页 UI 挂在 web 界面） |
| Node 版本 | `^22.19.0 \|\| >=24.0.0` |
| 许可证 | MIT |
| 运行时依赖 | **无**（零依赖，无 `node_modules`，安装无需构建/授权步骤） |

**权限与外部服务声明**：本插件**不访问任何外部服务，不发起任何出站网络请求**；所有数据只读写本机 `<DSH_HOME>`。涉及的能力：

- 读写 `<DSH_HOME>/sessions`（列表/导出/导入/删除，删除仅限「安全边界」一节列明的围栏内场景，且需 `confirm: true`）
- 读写插件自己的数据目录 `<DSH_HOME>/dsh-session-vault/`（归档暂存、上传暂存）
- 注册 4 个模型工具（`session_list` / `session_export` / `session_archive_inspect` / `session_import`），遵守会话自身的审批策略
- HTTP 路由仅服务回环请求并校验同源；对局域网暴露的部署不会开放这些端点

---

## English summary

`dsh-session-vault` is a DSH plugin that packages sessions into portable,
gzip-compressed NDJSON `.dshsession` archives and restores them through the
real persistence and workspace services. It ships a settings-page UI, five
model-facing tools, and a loopback-fenced HTTP route family. Archives are
normalised to the current session format, so they import into a newer DSH than
wrote them. Existing sessions are never overwritten: a colliding id is skipped
or imported under a fresh one.

It also reclaims disk from two kinds of junk — **unmounted** sessions (no
workspace accounts for them, in either the registry's validated view or the
durable workspace ledger) and **never-used** ones (mounted, but the log holds no
conversation at all, only the events that creating a session writes). That is the
one operation no host service offers, so it is the only place the plugin removes
files under `<DSH_HOME>/sessions`. Every path is re-derived through DSH's own
segment encoder and confined to the sessions root, and a real delete requires an
explicit `confirm`. Both wider reaches are additionally gated: an archived session
needs `includeArchived`, and a never-used one — normally mounted, therefore
otherwise undeletable — needs `includeEmpty` and is only ever admitted when the
log was actually read and found conversation-free. A session whose contents could
not be established is refused, never assumed unused.

Display titles resolve in three rungs: the projection cache, then the session's
own first human message (bounded to five words and 40 UTF-8 bytes, sanitised of
escape and directional marks), then "untitled" — except a session that recorded no
conversation, which says so rather than implying a missing value.

## License

MIT
