# A股板块资金流向可视化

一个用于观察 A 股板块资金流向的本地 Web 应用。它把板块资金排行、日内主力资金曲线、历史快照和成分股明细放在同一个界面里，适合用来复盘资金在不同板块之间的流动节奏。

![应用顶部概览](docs/overview.png)

## 这个项目做什么

普通行情页面通常只告诉你某个板块“涨了多少”或“流入多少”，但不容易看出资金是在什么时候开始加速、哪些板块互相分化、强弱关系有没有变化。这个项目把板块资金曲线画成一张可交互图表，并配合时间滑条、板块榜单和成分股明细，帮助你更直观地观察资金路径。

它更适合这些场景：

- 复盘当天资金主要流入和流出的板块
- 对比概念、行业、地域板块的强弱变化
- 观察某个板块资金是持续流入，还是盘中冲高后回落
- 点击板块后查看成分股，理解板块内部由哪些股票带动
- 在实时接口失败时，用本地历史快照继续查看页面效果

![筛选与数据源策略](docs/source-strategy.png)

## 核心功能

- **板块视图**：支持概念、行业、地域三类板块。
- **排行模式**：支持多空对照、净流入领先、净流出领先。
- **日内曲线**：展示板块从开盘到当前时刻的主力净流入变化。
- **时间滑条**：可以把图表固定到某一时刻，观察当时的板块强弱。
- **自动播放**：沿着时间轴播放资金变化过程。
- **历史回看**：支持本地历史快照，方便复盘和演示。
- **数据源策略**：优先使用东方财富公开接口，部分场景可使用新浪财经候补。
- **成分股明细**：点击板块后按需加载成分股，减少不必要的请求。

![主力资金曲线与板块速览](docs/flow-chart.png)

## 本地运行

项目需要本机安装 Node.js。

```powershell
npm start
```

启动后打开终端里显示的地址，默认是：

```text
http://localhost:3100
```

如果 `3100` 端口被占用，服务会自动尝试下一个可用端口，并在终端里打印最终地址。

## 主要文件

- `server.mjs`：本地 Web 服务、API 路由、数据抓取、快照回退逻辑。
- `public/index.html`：页面结构。
- `public/app.js`：前端交互、图表渲染、时间轴和板块列表逻辑。
- `public/styles.css`：页面样式。
- `tdx_bridge.py`：可选的通达信桥接辅助脚本。
- `data/`：本地缓存和历史快照目录，默认不提交到 Git。
- `docs/overview.png`：README 顶部概览效果图。
- `docs/source-strategy.png`：筛选面板和数据源策略效果图。
- `docs/flow-chart.png`：主力资金曲线和板块速览效果图。

## 数据说明

项目使用公开网页接口获取板块资金数据。由于公开接口可能出现延迟、失败、字段变化或访问限制，应用内置了本地快照回退机制：当实时数据不可用时，页面会尽量使用已有历史快照继续展示。

当前数据源策略包括：

- 东方财富板块资金：主要数据源。
- 新浪财经板块资金：部分场景下的实时候补源。
- 本地历史快照：实时接口失败时的最终兜底。
- 同花顺板块详情页：用于按需加载部分板块成分股信息。

## 适合谁用

这个项目适合想学习前端可视化、Node.js 数据接口、A 股板块资金结构，或者想做盘后复盘工具原型的人。它不是交易系统，也不会自动给出买卖建议。

## 免责声明

本项目仅用于学习、研究和数据可视化练习，不构成任何投资建议。公开数据源可能存在延迟、缺失或接口变化，请以官方平台信息为准。任何投资决策都应由你自行判断并承担风险。

---

# A-Share Sector Flow Visualizer

A local web app for visualizing A-share sector money flow. It combines sector rankings, intraday main-fund flow curves, historical snapshots, and on-demand constituent stock details in one interface, making it easier to review how capital rotates between sectors.

![App Overview](docs/overview.png)

## What It Does

Most market pages show whether a sector is up or down, but they do not always make it easy to see when money started accelerating, whether inflow was sustained, or how different sectors diverged intraday. This project turns sector flow data into an interactive chart with a timeline slider, ranking panel, source status, and constituent stock details.

It is useful for:

- Reviewing the strongest inflow and outflow sectors of the day
- Comparing concept, industry, and region sector behavior
- Checking whether a sector had sustained inflow or only a brief spike
- Opening a sector to inspect its constituent stocks
- Demonstrating the UI with local snapshots when live data is unavailable

![Filters and Source Strategy](docs/source-strategy.png)

## Features

- **Sector views**: concept, industry, and region sectors.
- **Ranking modes**: balanced, net inflow, and net outflow.
- **Intraday curves**: main-fund net flow from market open to the selected time.
- **Timeline slider**: freeze the chart at a specific intraday moment.
- **Playback**: replay the flow timeline automatically.
- **Historical snapshots**: review previously captured local data.
- **Source strategy**: Eastmoney as the primary source, with optional Sina fallback.
- **Constituent details**: load sector constituents on demand.

![Main Flow Chart and Sector Ranking](docs/flow-chart.png)

## Run Locally

Node.js is required.

```powershell
npm start
```

Then open the URL printed by the server. The default is:

```text
http://localhost:3100
```

If port `3100` is occupied, the server will try the next available port and print the final URL in the terminal.

## Project Files

- `server.mjs`: local web server, API routes, data fetching, and snapshot fallback logic.
- `public/index.html`: page structure.
- `public/app.js`: frontend interaction, chart rendering, timeline, and sector list logic.
- `public/styles.css`: page styling.
- `tdx_bridge.py`: optional Tongdaxin bridge helper.
- `data/`: local cache and historical snapshots, ignored by Git by default.
- `docs/overview.png`: overview screenshot used near the top of this README.
- `docs/source-strategy.png`: filters and source strategy screenshot.
- `docs/flow-chart.png`: main flow chart and sector ranking screenshot.

## Data Notes

This project uses public web endpoints for sector flow data. Public endpoints may be delayed, unavailable, rate-limited, or changed by upstream providers. To keep the app usable for review and demonstration, it can fall back to local historical snapshots when live requests fail.

Current source strategy:

- Eastmoney sector flow: primary source.
- Sina sector flow: optional live fallback in supported scenarios.
- Local snapshots: final fallback when live data is unavailable.
- Tonghuashun sector pages: on-demand source for some constituent details.

## Who This Is For

This project is useful if you want to learn frontend visualization, Node.js API design, A-share sector flow structure, or build a prototype for after-market review. It is not an automated trading system and does not provide buy or sell signals.

## Disclaimer

This project is for learning, research, and data visualization practice only. It is not investment advice. Public data sources may be delayed, incomplete, or changed by upstream providers; use official platforms as the final reference. Any investment decision is your own responsibility.
