# DSH Browser Benchmark

浏览器执行后端的端到端评测，共用 DSH web profile、模型、任务与本机 Chromium。

- `playwright`：runner 内置的 Playwright 基线插件，向模型暴露与产品一致的 `browser_*` 工具契约。
- `extension`：本仓库真实的 DSH browser bridge + Chrome MV3 扩展。

测量范围：模型收到任务 → DSH turn 完整结束。主指标：耗时与成功率。

## 快速开始

先从仓库根目录安装与 lockfile 中 `playwright-core` 匹配的 Chrome for Testing、构建当前代码并检查运行矩阵：

```bash
pnpm --dir benchmark install-browser
pnpm build
node benchmark/run.mjs --dry-run --smoke
```

扩展自动加载需要 Chrome for Testing 或 Chromium；Google Chrome Stable 忽略 `--load-extension`，不作为扩展后端的评测浏览器。

不调用模型的全链路基础设施探针：

```bash
pnpm --dir benchmark probe
```

真实 smoke 调用当前 DSH profile 配置的模型并消耗模型额度：

```bash
node benchmark/run.mjs --smoke
```

正式运行默认执行 6 个任务 × 5 个 seed × 2 个后端，共 60 次：

```bash
node benchmark/run.mjs
```

常用参数：

```bash
node benchmark/run.mjs \
  --tasks order_lookup,contact_form,cart_checkout \
  --seeds 1-5 \
  --trials 2 \
  --timeout-ms 120000
```

如需固定模型，两边会对各自 session 应用同一选择：

```bash
node benchmark/run.mjs --provider <provider-id> --model <model-id> --reasoning-effort <effort-id>
```

结果逐行写入 `results/<timestamp>.jsonl`，结束后自动生成对应的 `.report.md`。也可以重新生成最近一份报告：

```bash
node benchmark/report.mjs
node benchmark/report.mjs benchmark/results/<file>.jsonl
```

`--output` 仅接受新文件。每轮评测独立保存；报告拒绝混合 `benchmarkSuiteVersion`。合并分析按套件版本、模型与环境配置分组。

## 任务集

任务全部运行在 `127.0.0.1` 上的确定性网页中，不依赖外网数据：

| 任务 | 类型 | 验证方式 |
| --- | --- | --- |
| `order_lookup` | 读取 | 最终回答包含 seed 对应金额 |
| `notification_toggle` | 单步写操作 | 服务端状态确认已开启并保存 |
| `contact_form` | 表单 | 服务端状态确认三个字段和提交动作 |
| `inventory_filter` | 筛选 + 读取 | 服务端确认筛选值，回答确认唯一商品 |
| `cart_checkout` | 多步操作 | 服务端确认商品、数量和结算 |
| `lazy_load` | 动态内容 | 服务端确认加载动作，回答确认新代码 |

任务数据由 seed 确定。网页状态由独立 HTTP API 验证，最终回答由任务 validator 校验。

任务套件版本：`2`。`inventory_filter` 的商品根名称、SKU、价格和库存顺序随 seed 变化，目标商品名不含 seed 数字。缺少 `benchmarkSuiteVersion` 的结果与版本 `2` 分组统计。任务提示、数据生成或 validator 语义变化时递增套件版本。

## 公平性控制

- 两边共享同一提示词、任务实例、DSH profile、模型选择、浏览器尺寸、locale 和时区。
- Playwright 适配器使用与扩展相同的 `browser_snapshot`、`browser_click`、`browser_type` 等模型可见工具名、说明、参数 schema 和通用系统提示；动作后的 DOM 稳定等待策略也使用相同时间预算。
- 两个 DSH 进程使用隔离的 session/storage 目录，共用本机 DSH profile 的模型凭据。
- 同任务、同 seed 形成一个 pair，先后顺序由确定性哈希交替。
- 提示词禁止非 `browser_*` 工具，validator 也会把使用其他工具的运行判为失败。
- 两边都使用当前仓库构建产物；正式评测前必须先执行 `pnpm build`。

## 指标定义

- `success`：网页外部状态和/或最终答案通过任务 validator，未使用禁用工具，并以 `turn/end: completed` 结束。
- `timings.completionMs`：调用 `session.prompt` 前到收到对应 `turn/end` 的端到端耗时，是报告的主指标。
- `timings.stateReachedMs`：写操作首次在独立网页状态 API 中达到目标的时间，50ms 轮询精度。
- `timings.ttftMs`：从主计时起点到第一个非空模型 stream delta。
- `timings.toolWallMs`：runner 从 `tool/call` 到匹配 `tool/result` 观察到的工具耗时之和。
- `tokens`：该 turn 中所有 assistant step 报告的 token 总和。报告将新输入、缓存读取、缓存写入和输出分列；总览中的 `prompt token` 是前三项之和。

| 统计项 | 规则 |
|---|---|
| 常规延迟 | 仅计算成功运行，并列展示成功率 |
| P90 | 至少 10 个成功样本时展示 |
| 配对结果 | 分列双方成功、仅一方成功和双方失败 |
| 失败惩罚 | 失败样本按 `2 × timeout` 计时 |

## 解释边界

- 评测范围为完整浏览器后端：页面表示、元素索引、动作执行与模型调用。
- 模型可见工具契约一致，后端实现各自独立。
- 速度比反映端到端耗时，不能单独归因于传输；模型服务端延迟不由本地 runner 隔离。
- 结论须同时包含成功率、配对结果、失败惩罚比、运行顺序敏感性和置信区间。

## 正式评测流程

1. 关闭会争抢 CPU 的应用，固定网络环境和 DSH/model 配置。
2. 先跑 `--smoke`，确认两边都成功。
3. 至少使用默认 5 个 seed；结果噪声大时增加 `--trials`。
4. 先比较成功率，再看成功配对的耗时比和 95% bootstrap 置信区间。
5. 保留原始 JSONL；报告可由其重算。`diagnostics.eventTypeRuns` 为无损连续事件计数，按 `{ type, count }` 展开还原完整事件顺序。

## 目录结构

```text
benchmark/
  lib/                    runner、DSH client、统计与任务定义
  patches/                两个隔离 DSH backend 的 profile patch
  plugin/                 Playwright 基线的 browser_* 插件
  site/                   本地确定性任务站
  tests/                  不调用模型的单元/集成测试
  results/                原始 JSONL 和 Markdown 报告（默认 gitignore）
  run.mjs                 统一配对 runner
  probe.mjs               不调用模型的后端/扩展连接探针
  report.mjs              报告生成器
  tasks.json              任务目录元数据
```

运行测试：

```bash
pnpm --dir benchmark test
```
