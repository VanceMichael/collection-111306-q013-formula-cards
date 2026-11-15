# 技术公式网页的结构化资料采集

我们要把供方技术站上的计算说明接进内部检索，现在直接抓纯文本会把分式的分子分母连成一个数字，上下标也看不出归属；同一公式的可访问文本和渲染结构还被收了两次。这里保存现有资料预览工具和本地供方模拟服务，便于离线开发和复查领取行为。

## 当前能力

`npm run demo` 从实际本地资料源获取一次完整演示：初始稳定采集、纯文本预览、迟到替换（先单次快照标待确认、再稳定窗口确认）、修改一条注解，最后从接收文件重新读取并打印检索、来源回查、冲突与待确认项，结果写入 `var/captures.json`。

公式卡片采集已交付的行为：

- 分式与上下标保留为结构树（`fraction`/`superscript`/`subscript` 等节点），不求值、不做代数化简，原始串同时保留。
- 同一公式的 MathML 渲染结构、TeX 注解、隐藏文字替代按证据分组到同一公式条目，不重复计数；证据强弱写入记录（`semantics` 绑定强于同卡片隐藏替代）。
- 表达不一致时两份都保留并给出差异路径（如 `numerator`），不挑选较长或较短的一份；无法核对的表达标记待确认并保留原文。
- 符号说明与适用条件按卡片作用域归属（`formulaIdentity(卡片, 符号)`），不同卡片的同名符号不合并，脚注条件只属于所在卡片。
- 整页快照在单个 JS 任务内原子读取，同一条分式的分子分母永远来自同一瞬间；稳定窗口确认前被替换的旧快照记入 `capture.superseded`，不并入确认结果；单次快照一律标记待确认。
- 结构化记录可检索分式、上下标、符号作用域、条件关系、冲突与待确认项，每条带来源回查（接收修订号、来源地址、原文选择器、表达证据）。

`src/domain.mjs` 保留已有领域预览函数；`src/store.mjs` 提供带完整性校验的单进程顺序接收文件，不是跨进程事务数据库。纯文本预览作为 `text-preview` 记录保留。

## 运行

容器内固定 Playwright 1.56.1 与匹配的 Chromium。浏览器只访问本进程启动的回环资料源，不需要访问外部门户。

```sh
npm ci
npx playwright install chromium
npm run build
npm test
npm run demo
```

推荐使用固定镜像构建，首次构建会安装锁文件中的依赖；运行时不需联网。

```sh
docker build -t plant-formula-cards .
docker run --rm --network none --ipc=host plant-formula-cards npm test
docker run --rm --network none --ipc=host plant-formula-cards npm run demo
```

开发时 `npm start` 打印本地源地址；设置 `PORT` 可指定监听端口，未设置时自动分配回环端口。浏览器页面或 HTTP 接口可直接查看。`CAPTURE_PATH` 可改变接收文件路径。重复运行预览追加记录；删除 `var` 可从空接收状态开始。

## 模块

- `src/source.mjs`：该业务的本地资料源与演示控制，独立于待扩展的接收行为。
- `src/domain.mjs`：现有原始资料预览和领域数据结构。
- `src/structure.mjs`：MathML/TeX/中文文字替代 → 结构树的纯函数解析、结构比对与符号说明解析。
- `src/cards.mjs`：页面原子快照、稳定窗口确认、公式卡片记录构建（表达分组、证据、一致性评估）。
- `src/query.mjs`：接收记录的检索索引（分式、上下标、符号作用域、条件、冲突、待确认、被替换表达）与来源回查。
- `src/preview.mjs`：读取、预览及持久化的一次运行入口。
- `fixtures/source.json` 与 `fixtures/controls.json`：本地供方资料及可切换情形。
- `docs/source.md`：接口和来源约定。
- `test`：现有预览、源端特殊情形、接收文件完整性测试，以及公式卡片采集的结构、纯逻辑与浏览器端到端测试。

## 业务核对

以下情况均可由接收方独立观察，并有对应测试：

- 分式与上下标保留结构：`test/structure.test.mjs`、`test/formula-cards.test.mjs`。
- 同公式多表达不重复：`test/cards.test.mjs`（多表达分组到同一公式条目）。
- 不同卡片同名符号独立：`test/query.test.mjs`、`test/formula-cards.test.mjs`。
- 注解与结构不一致保留差异：`test/cards.test.mjs`、`test/formula-cards.test.mjs`。
- 迟到替换不能产生混合表达：`test/cards.test.mjs`（稳定窗口与 superseded）、`test/formula-cards.test.mjs`（确认分式原子完整）。

新增行为在独立模块扩展，保留原有预览调用；源端模拟器不替接收器完成核对。

## 短时操作演示

从空 `var` 运行 `npm run demo`，展示本次真实读取和接收路径：五个采集步骤的实际状态、检索演示（分式/上下标/符号作用域/条件关系）、迟到替换核对（被替换旧表达与确认分式）、冲突结果、待确认表达及原因、来源回查示例。再运行 `npm test` 查看本地源边界、接收文件检查与公式卡片采集行为。固定环境中的这两步应在 90 秒内完成。演示只展示当次实际完成情况，不回放旧日志，不以源端控制操作代替接收结果。
