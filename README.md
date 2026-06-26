# A-Share Sector Flow Visualizer

A web app for visualizing A-share sector money flow. It shows intraday main-fund flow curves, sector rankings, historical snapshots, and on-demand constituent stock details.

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
