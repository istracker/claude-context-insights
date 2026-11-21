# claude-context-insights

> 非官方插件，专为 Claude Code / Claude Desktop 设计，与 Anthropic 无关联。插件名 `cc-context-insights`，命令 `/ctx`。

「上下文洞察」面板：打开是所有会话的总览。功能设计参考 [dsh-context](https://github.com/bowenliang123/dsh-context)（Apache-2.0），配色取自 Claude 自己的上下文用量界面。

## 总览

读取本机 `~/.claude/projects` 下所有会话日志（含子 Agent），按「今天 / 7 天 / 30 天 / 全部」与账号筛选汇总：

顶部三个页签，每页控制在一屏内，面板不需要滚动（桌面端面板滚动时宿主同步滚动位置会抖动，分页签从设计上避开）：

- **总览**：订阅额度 + 花费
- **会话**：搜索、排序、以项目为主线的列表（项目每页 6 个，一次只展开一个项目，展开的项目里会话每页 4 个）
- **工具**：工具上下文；点一项会筛选会话并跳到「会话」页签

- **订阅额度**：当前账号实时读数；所有账号完整显示（宽面板每行两个），非当前账号标出读数时间
- **花费（一张卡片，从总数往下读）**：顶部是等价 API 成本与环比，下面一行淡色补充 token、缓存命中、会话、提问、每次提问成本与工具调用；接着是压矮的每日柱状图（悬停看当天明细，图注日均与今天）；最后是构成表，可在「按类型 / 按模型 / 按账号」间切换（名称 · token · 金额 · 占比），点模型名筛选会话、点账号名切换账号（按账号仅在多账号时出现）
- **会话（以项目为主线）**：每个项目一行（会话数 · 最近活动 · token 消耗 · 占比，不画进度条），默认展开第一个，点项目名展开 / 收起（一次只展开一个）；项目每页 6 个、展开项目里的会话每页 4 个；搜索框（标题 / 项目 / 最后消息）与点选筛选时展开第一个有结果的项目；按时间、token 或当前上下文排序（同时决定项目顺序）；每个会话一张两行卡片（标题 · 时间 / 账号 · token · 最后一条消息），点标题在 Claude Desktop 里打开（当前登录账号的会话），其余复制恢复命令（带 `cd` 项目目录）；当前会话标「当前」
- **工具上下文**：全宽紧凑表，列出累计 token、调用次数与平均每次（按入参与返回内容估算），可点表头切换排序、可展开 MCP；平均每次超过 10k 标黄并给出建议；默认显示 4 项；点一项筛选上方会话

## 当前会话的上下文（`/ctx full` 进入，「← 返回洞察」回到总览）

- 运行时的实时数据，与自带的 `/context` 同口径——已使用百分比、按类别分段的占用条和三列明细（名称 · token · 占比）、订阅额度、逐请求的上下文趋势（橙色虚线为自动压缩阈值）、上下文骤降事件流、本会话统计、活动（支持按全部 / 读 / 写筛选与展开文件）、子 Agent。默认本地估算，点「精确统计」调用 token 计数接口

口径：一次 API 响应在日志中拆成多行，按 requestId 去重。成本取每个会话日志里 `cost-state` 记录的本地估算，按 Claude 标价比例（5 分钟 / 1 小时缓存写 1.25 / 2 倍、缓存读按模型 0.05～0.1 倍［Opus/Sonnet 5.5 为 0.05 倍］、输出 5 倍）摊到各天与各类；进行中或恢复过的会话没有最新 `cost-state`，按同模型已结束会话学到的单价估算，标「≈」。会话与账号的对应取自 Claude Desktop 的 `claude-code-sessions/<账号>/<组织>/local_*.json`（含 `priorCliSessionIds`），账号别名可写在 `~/.claude/cc-context-insights/accounts.json`（支持 `CLAUDE_CONFIG_DIR`）。首次扫描全量读取，之后按字节偏移只读新增部分，结果缓存在插件的 `$.store` 中。

## 安装

从 GitHub 安装：

```bash
claude plugin install cc-context-insights --marketplace istracker/claude-context-insights
```

在 Claude Code 会话里也可以用 `/plugin install cc-context-insights --marketplace istracker/claude-context-insights`。

从本地克隆的仓库安装（插件直接读取该目录，改代码后执行 `claude plugin update cc-context-insights@cc-context-insights-local` 并新开会话生效）：

```bash
claude plugin install cc-context-insights --marketplace /path/to/claude-context-insights
```

安装后新开一个会话才会加载。

## 使用

面板在会话开始时自动打开，显示总览。关掉后用唯一的命令重新打开：

- `/ctx`：打开总览，顺带增量扫描日志
- `/ctx full`：直接进入当前会话的上下文，并做一次精确统计
- `/ctx close`：关闭面板（也可以点面板右上角的 ✕，或按 Esc）

桌面端、VS Code 和移动端用 SVG 画图，终端用文字条和迷你趋势字符。

## 局限

- 等价 API 成本是按标价折算的本地估算，不是账单；订阅用户不按它计费，上限看订阅额度
- 当前会话的请求、趋势和活动从面板加载后开始累计；成本和窗口占用是整个会话的
- 插件无法让 Claude Desktop 切换到另一个对话；要继续某个历史对话，用「复制恢复命令」
