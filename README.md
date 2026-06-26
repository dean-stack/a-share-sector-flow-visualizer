# A股板块资金流向可视化

一个用于观察 A 股板块资金流向的本地 Web 应用。它可以展示板块日内主力资金曲线、板块排行、历史快照，以及按需加载的成分股明细。

## 功能

- 支持概念、行业、地域三类板块视图
- 支持多空对照、净流入领先、净流出领先三种排行模式
- 支持日内时间轴滑块和自动播放
- 优先使用东方财富实时数据，失败时回退到本地历史快照
- 支持部分场景下使用新浪财经作为实时候补源
- 点击板块后按需加载成分股详情

## 本地运行

```powershell
npm start
```

然后打开：

```text
http://localhost:3100
```

如果 `3100` 端口被占用，服务会自动尝试下一个可用端口，并在终端里打印最终访问地址。

## 文件说明

- `server.mjs`：本地 Web 服务和数据接口
- `public/`：浏览器前端界面
- `tdx_bridge.py`：可选的通达信桥接辅助脚本
- `data/`：本地缓存和历史快照目录，已被 Git 忽略

## 免责声明

本项目仅用于学习、研究和数据可视化练习，不构成任何投资建议。公开数据源可能存在延迟、缺失或接口变化，请以官方平台信息为准。

---

# A-Share Sector Flow Visualizer

A local web app for visualizing A-share sector money flow. It shows intraday main-fund flow curves, sector rankings, historical snapshots, and on-demand constituent stock details.

## Features

- Concept, industry, and region sector views
- Balanced, net inflow, and net outflow ranking modes
- Intraday timeline slider and playback
- Eastmoney live data with local snapshot fallback
- Optional Sina live fallback for supported categories
- On-demand constituent stock loading

## Run Locally

```powershell
npm start
```

Then open:

```text
http://localhost:3100
```

If port `3100` is occupied, the server will try the next available port and print the final URL in the terminal.

## Files

- `server.mjs`: local web server and data API
- `public/`: browser UI
- `tdx_bridge.py`: optional Tongdaxin bridge helper
- `data/`: local cache and snapshots, ignored by Git

## Disclaimer

This project is for learning, research, and data visualization practice only. It is not investment advice. Public data sources may be delayed, incomplete, or changed by upstream providers; use official platforms as the final reference.
