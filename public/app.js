const state = {
  category: "concept",
  mode: "balanced",
  limit: 12,
  policy: "taxonomy",
  selectedDate: "today",
  currentDate: "",
  payload: null,
  selectedBoardCode: "",
  selectedBoardName: "",
  constituents: null,
  frameIndex: 0,
  playing: false,
  playTimer: null
};

const categoryLabels = {
  concept: "概念板块",
  industry: "行业板块",
  region: "地域板块"
};

const chartEl = document.getElementById("chart");
const chart = echarts.init(chartEl, null, { renderer: "canvas" });

const refs = {
  tradeDate: document.getElementById("tradeDate"),
  updatedTime: document.getElementById("updatedTime"),
  chartKicker: document.getElementById("chartKicker"),
  chartTitle: document.getElementById("chartTitle"),
  loadingState: document.getElementById("loadingState"),
  strongestName: document.getElementById("strongestName"),
  strongestValue: document.getElementById("strongestValue"),
  weakestName: document.getElementById("weakestName"),
  weakestValue: document.getElementById("weakestValue"),
  strategyHint: document.getElementById("strategyHint"),
  strategyList: document.getElementById("strategyList"),
  boardList: document.getElementById("boardList"),
  constituentsTitle: document.getElementById("constituentsTitle"),
  constituentsMeta: document.getElementById("constituentsMeta"),
  constituentsCount: document.getElementById("constituentsCount"),
  constituentsPositive: document.getElementById("constituentsPositive"),
  constituentsNegative: document.getElementById("constituentsNegative"),
  constituentsLabelEls: document.querySelectorAll("#constituentsSummary .constituent-stat span"),
  constituentsTable: document.getElementById("constituentsTable"),
  policySelect: document.getElementById("policySelect"),
  limitSelect: document.getElementById("limitSelect"),
  categoryGroup: document.getElementById("categoryGroup"),
  modeGroup: document.getElementById("modeGroup"),
  dateSelect: document.getElementById("dateSelect"),
  refreshButton: document.getElementById("refreshButton"),
  playButton: document.getElementById("playButton"),
  timeSlider: document.getElementById("timeSlider"),
  playbackTime: document.getElementById("playbackTime"),
  playbackStatus: document.getElementById("playbackStatus")
};

const desktopPalette = [
  "#6d1317",
  "#83222a",
  "#a13a2e",
  "#bc6134",
  "#c9892a",
  "#c9a92a",
  "#88916f",
  "#6b8ca0",
  "#4b7f9d",
  "#2e657e",
  "#1f7054",
  "#14583d",
  "#2a6c4a",
  "#3f7f5b",
  "#5d7459",
  "#3e4d5b"
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(value) {
  const numeric = Number(value || 0);
  const sign = numeric > 0 ? "+" : numeric < 0 ? "-" : "";
  const abs = Math.abs(numeric);

  if (abs >= 1e8) {
    return `${sign}${(abs / 1e8).toFixed(abs >= 1e10 ? 0 : 2)}亿`;
  }

  if (abs >= 1e4) {
    return `${sign}${(abs / 1e4).toFixed(abs >= 1e6 ? 0 : 2)}万`;
  }

  return `${sign}${abs.toFixed(0)}`;
}

function formatPercent(value) {
  const numeric = Number(value || 0);
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(2)}%`;
}

function formatPlainNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }
  return Number(value).toFixed(Number(value) >= 100 ? 0 : 2);
}

function setActiveButton(group, attr, value) {
  group.querySelectorAll(".chip").forEach((button) => {
    button.classList.toggle("is-active", button.dataset[attr] === value);
  });
}

function stopPlayback() {
  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = null;
  }
  state.playing = false;
  refs.playButton.textContent = "播放";
}

function getFramePoint(board, frameIndex) {
  if (!board?.series?.length) return null;
  return board.series[Math.min(frameIndex, board.series.length - 1)] || null;
}

function getSortedByFrame(boards, frameIndex) {
  return [...boards].sort((left, right) => {
    const leftValue = getFramePoint(left, frameIndex)?.mainNet ?? left.mainNet ?? 0;
    const rightValue = getFramePoint(right, frameIndex)?.mainNet ?? right.mainNet ?? 0;
    return rightValue - leftValue;
  });
}

function renderBoardList(boards, frameIndex) {
  refs.boardList.innerHTML = boards
    .map((board) => {
      const point = getFramePoint(board, frameIndex);
      const mainNet = point?.mainNet ?? board.mainNet ?? 0;
      const signClass = mainNet >= 0 ? "positive" : "negative";
      const isSelected = state.selectedBoardCode === board.code ? "is-selected" : "";

      return `
        <article class="board-row ${isSelected}" data-board-code="${escapeHtml(board.code)}" data-board-name="${escapeHtml(board.name)}">
          <div class="board-main">
            <strong>${escapeHtml(board.name)}</strong>
            <span>${escapeHtml(board.code)} · ${formatPercent(board.changePercent)} · ${escapeHtml(board.leaderName || "暂无龙头映射")}</span>
          </div>
          <div class="board-side">
            <strong class="${signClass}">${formatMoney(mainNet)}</strong>
            <span class="${board.changePercent >= 0 ? "positive" : "negative"}">${formatPercent(board.changePercent)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderConstituents(payload) {
  if (refs.constituentsLabelEls.length >= 3) {
    refs.constituentsLabelEls[0].textContent = "成分股数";
    refs.constituentsLabelEls[1].textContent = "上涨家数";
    refs.constituentsLabelEls[2].textContent = "下跌家数";
  }

  if (!payload) {
    refs.constituentsTitle.textContent = "点击板块查看成分股";
    refs.constituentsMeta.textContent = "按需加载，减少上游请求频率";
    refs.constituentsCount.textContent = "--";
    refs.constituentsPositive.textContent = "--";
    refs.constituentsNegative.textContent = "--";
    refs.constituentsTable.innerHTML = "";
    return;
  }

  refs.constituentsTitle.textContent = `${state.selectedBoardName} 成分股`;
  const provider = payload.source?.provider || "板块成分股数据";
  const note = payload.source?.note || payload.sortLabel || "";
  const fallback =
    payload.fromSnapshot && payload.fallbackReason
      ? ` · 已回退本地快照：${payload.fallbackReason}`
      : payload.partial && payload.fallbackReason
        ? ` · 部分结果：${payload.fallbackReason}`
        : "";
  refs.constituentsMeta.textContent = `${provider}${note ? ` · ${note}` : ""}${fallback}`;
  refs.constituentsCount.textContent = String(payload.count);
  refs.constituentsPositive.textContent = String(payload.positiveCount);
  refs.constituentsNegative.textContent = String(payload.negativeCount);

  if (!payload.constituents?.length) {
    refs.constituentsTable.innerHTML = `
      <article class="constituent-row">
        <div class="constituent-main">
          <strong>暂无可用成分股数据</strong>
          <span>${payload.source?.provider || "当前来源暂时不可用"}</span>
        </div>
      </article>
    `;
    return;
  }

  refs.constituentsTable.innerHTML = payload.constituents
    .map((stock) => {
      const changeClass = stock.changePercent >= 0 ? "is-positive" : "is-negative";
      return `
        <article class="constituent-row">
          <div class="constituent-main">
            <strong>${escapeHtml(stock.name)}</strong>
            <span>${escapeHtml(stock.code)} · 现价 ${formatPlainNumber(stock.latest)} · 市盈 ${formatPlainNumber(stock.peTtm)}</span>
          </div>
          <div class="constituent-mid">
            <strong class="${changeClass}">${formatPercent(stock.changePercent)}</strong>
            <span>换手 ${formatPercent(stock.turnoverRate)} · 成交额 ${escapeHtml(stock.turnoverAmountLabel || "--")}</span>
          </div>
          <div class="constituent-side">
            <strong>${escapeHtml(stock.floatMarketValueLabel || "--")}</strong>
            <span>流通市值 · 振幅 ${formatPercent(stock.amplitude)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderSourceStrategy(payload) {
  if (!payload) {
    refs.strategyHint.textContent = "正在读取当前数据源策略...";
    refs.strategyList.innerHTML = "";
    return;
  }

  refs.strategyHint.textContent = payload.recommendation || "当前使用默认策略";
  refs.strategyList.innerHTML = payload.sources
    .map((source) => {
      return `
        <article class="strategy-card" data-status="${source.status}">
          <strong>${source.name}</strong>
          <span>${source.role} · ${source.capabilities}</span>
          <em>${source.status}</em>
          <small>${source.note || ""}</small>
        </article>
      `;
    })
    .join("");
}

async function loadSourceStrategy(usingSnapshot, activeSource = "eastmoney-live") {
  try {
    const response = await fetch(
      `/api/source-strategy?category=${encodeURIComponent(state.category)}&mode=${encodeURIComponent(state.mode)}&limit=${encodeURIComponent(state.limit)}&policy=${encodeURIComponent(state.policy)}&usingSnapshot=${usingSnapshot ? "1" : "0"}&activeSource=${encodeURIComponent(activeSource)}`
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || "加载数据源策略失败");
    }
    renderSourceStrategy(payload);
  } catch (error) {
    refs.strategyHint.textContent = error.message;
    refs.strategyList.innerHTML = "";
  }
}

async function loadConstituents(boardCode, boardName) {
  if (!state.payload) return;

  state.selectedBoardCode = boardCode;
  state.selectedBoardName = boardName;
  renderBoardList(getSortedByFrame(state.payload.boards, state.frameIndex), state.frameIndex);
  refs.constituentsTitle.textContent = `${boardName} 成分股`;
  refs.constituentsMeta.textContent = "正在加载成分股...";
  refs.constituentsTable.innerHTML = "";

  try {
    const response = await fetch(
      `/api/board-constituents?boardCode=${encodeURIComponent(boardCode)}&category=${encodeURIComponent(state.category)}&boardName=${encodeURIComponent(boardName)}`
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || "加载成分股失败");
    }

    state.constituents = payload;
    renderConstituents(payload);
  } catch (error) {
    refs.constituentsMeta.textContent = error.message;
    refs.constituentsTable.innerHTML = `
      <article class="constituent-row">
        <div class="constituent-main">
          <strong>加载成分股失败</strong>
          <span>${error.message}</span>
        </div>
      </article>
    `;
  }
}

function updateSummary(payload, frameIndex) {
  const sortedBoards = getSortedByFrame(payload.boards, frameIndex);
  const strongest = sortedBoards[0] || null;
  const weakest =
    [...sortedBoards].sort((left, right) => {
      const leftValue = getFramePoint(left, frameIndex)?.mainNet ?? left.mainNet ?? 0;
      const rightValue = getFramePoint(right, frameIndex)?.mainNet ?? right.mainNet ?? 0;
      return leftValue - rightValue;
    })[0] || null;

  refs.tradeDate.textContent = payload.tradeDate || "--";
  refs.updatedTime.textContent = payload.timeline?.[frameIndex] || payload.updatedTime || "--";
  refs.chartKicker.textContent = categoryLabels[payload.category] || payload.categoryLabel;
  refs.chartTitle.textContent = `${payload.categoryLabel}日内主力净流入曲线`;
  refs.strongestName.textContent = strongest?.name || "--";
  refs.strongestValue.textContent = strongest
    ? formatMoney(getFramePoint(strongest, frameIndex)?.mainNet ?? strongest.mainNet)
    : "--";
  refs.weakestName.textContent = weakest?.name || "--";
  refs.weakestValue.textContent = weakest
    ? formatMoney(getFramePoint(weakest, frameIndex)?.mainNet ?? weakest.mainNet)
    : "--";
}

function buildChartOption(payload, frameIndex) {
  const timeline = payload.timeline || [];
  const frameTime = timeline[frameIndex] || payload.updatedTime || "--";
  const isMobile = window.innerWidth < 720;
  const rightPadding = isMobile ? 108 : 176;

  const series = payload.boards.map((board, index) => {
    const sliced = board.series.slice(0, frameIndex + 1);
    const currentPoint = sliced.at(-1);
    const currentValue = currentPoint?.mainNet ?? 0;

    return {
      name: board.name,
      type: "line",
      smooth: 0.18,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 6,
      clip: true,
      lineStyle: {
        width: index < 4 ? 3.4 : 2.1,
        color: desktopPalette[index % desktopPalette.length],
        shadowBlur: index < 4 ? 12 : 0,
        shadowColor: "rgba(0,0,0,0.12)"
      },
      itemStyle: {
        color: desktopPalette[index % desktopPalette.length]
      },
      emphasis: {
        focus: "series"
      },
      endLabel: {
        show: true,
        formatter: () => `${board.name} ${formatMoney(currentValue)}`,
        color: "#3c2b22",
        fontSize: isMobile ? 9 : 11,
        backgroundColor: "rgba(255,250,244,0.94)",
        borderColor: desktopPalette[index % desktopPalette.length],
        borderWidth: 1,
        borderRadius: 10,
        padding: isMobile ? [3, 6] : [4, 8]
      },
      labelLayout: {
        moveOverlap: "shiftY",
        hideOverlap: false
      },
      data: sliced.map((point) => point.mainNet)
    };
  });

  return {
    animationDuration: state.playing ? 260 : 420,
    animationDurationUpdate: state.playing ? 260 : 420,
    grid: {
      top: 44,
      left: 16,
      right: rightPadding,
      bottom: 32,
      containLabel: true
    },
    backgroundColor: "transparent",
    legend: {
      type: "scroll",
      top: 0,
      left: 0,
      right: rightPadding,
      icon: "roundRect",
      itemWidth: 12,
      itemHeight: 8,
      textStyle: {
        color: "#715a4d",
        fontSize: isMobile ? 10 : 11
      }
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "cross",
        lineStyle: {
          color: "rgba(71, 43, 31, 0.28)"
        }
      },
      backgroundColor: "rgba(42, 30, 25, 0.92)",
      borderWidth: 0,
      textStyle: {
        color: "#fff8f1"
      },
      formatter(params) {
        const title = params[0]?.axisValueLabel || frameTime;
        const lines = params
          .slice()
          .sort((left, right) => right.value - left.value)
          .map((item) => `${item.marker}${item.seriesName}：${formatMoney(item.value)}`);
        return [title, ...lines].join("<br>");
      }
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: timeline.slice(0, frameIndex + 1),
      axisLine: {
        lineStyle: {
          color: "rgba(94, 68, 50, 0.28)"
        }
      },
      axisTick: { show: false },
      axisLabel: {
        color: "#6d5a4d",
        fontSize: isMobile ? 10 : 11,
        interval(value, index) {
          const marks = new Set(["09:31", "10:30", "11:30", "14:00", "15:00"]);
          return marks.has(timeline[index]);
        }
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: {
        color: "#6d5a4d",
        fontSize: isMobile ? 10 : 11,
        formatter(value) {
          return formatMoney(value);
        }
      },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: {
        lineStyle: {
          color: "rgba(94, 68, 50, 0.12)",
          type: "dashed"
        }
      }
    },
    graphic: [
      {
        type: "text",
        right: isMobile ? 18 : 182,
        top: "middle",
        rotation: -0.46,
        silent: true,
        style: {
          text: `${payload.categoryLabel}资金流`,
          fill: "rgba(133, 96, 71, 0.08)",
          font: `${isMobile ? 20 : 34}px sans-serif`
        }
      }
    ],
    series
  };
}

function renderFrame() {
  if (!state.payload?.boards?.length) return;

  const frameTime = state.payload.timeline?.[state.frameIndex] || "--";
  refs.playbackTime.textContent = frameTime;
  refs.playbackStatus.textContent = state.playing
    ? `正在播放：显示从开盘到 ${frameTime} 的累计变化`
    : `当前位置：显示从开盘到 ${frameTime} 的累计变化`;

  updateSummary(state.payload, state.frameIndex);
  chart.setOption(buildChartOption(state.payload, state.frameIndex), true);
  renderBoardList(getSortedByFrame(state.payload.boards, state.frameIndex), state.frameIndex);
}

function setFrameIndex(nextIndex) {
  if (!state.payload?.boards?.length) return;

  const maxIndex = Math.max(state.payload.boards[0].series.length - 1, 0);
  state.frameIndex = Math.max(0, Math.min(nextIndex, maxIndex));
  refs.timeSlider.value = String(state.frameIndex);
  renderFrame();
}

function applyAvailableDates(payload) {
  state.currentDate = payload.currentDate;
  const savedDates = payload.availableDates || [];
  const options = [
    { value: "today", label: `今天（${payload.currentDate}）` },
    ...savedDates
      .filter((date) => date !== payload.currentDate)
      .map((date) => ({ value: date, label: date }))
  ];

  const currentValue = options.some((item) => item.value === state.selectedDate)
    ? state.selectedDate
    : "today";

  refs.dateSelect.innerHTML = options
    .map((item) => `<option value="${item.value}">${item.label}</option>`)
    .join("");
  refs.dateSelect.value = currentValue;
  state.selectedDate = currentValue;
}

async function loadData({ refresh = false } = {}) {
  stopPlayback();
  refs.loadingState.textContent = refresh ? "正在刷新当天数据..." : "加载中...";
  renderSourceStrategy(null);

  try {
    const params = new URLSearchParams({
      category: state.category,
      mode: state.mode,
      limit: String(state.limit),
      policy: state.policy
    });

    if (state.selectedDate && state.selectedDate !== "today") {
      params.set("date", state.selectedDate);
    }

    if (refresh) {
      params.set("refresh", "1");
      params.delete("date");
    }

    const response = await fetch(`/api/sector-flows?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || "加载失败");
    }

    state.payload = payload;
    const requestedLimit = Number(payload.requestedLimit || state.limit);
    const actualLimit = Number(payload.limit || 0);

    if (!payload.fromSnapshot && actualLimit && actualLimit !== state.limit) {
      state.limit = actualLimit;
      refs.limitSelect.value = String(actualLimit);
    } else {
      state.limit = requestedLimit;
      refs.limitSelect.value = String(requestedLimit);
    }

    state.selectedBoardCode = "";
    state.selectedBoardName = "";
    state.constituents = null;
    renderConstituents(null);
    applyAvailableDates(payload);

    if (!payload.boards?.length) {
      chart.clear();
      refs.tradeDate.textContent = payload.tradeDate || "--";
      refs.updatedTime.textContent = "--";
      refs.chartKicker.textContent = categoryLabels[payload.category] || payload.categoryLabel || "--";
      refs.chartTitle.textContent = `${categoryLabels[payload.category] || payload.categoryLabel || ""}暂无可用主图数据`;
      refs.strongestName.textContent = "--";
      refs.strongestValue.textContent = "--";
      refs.weakestName.textContent = "--";
      refs.weakestValue.textContent = "--";
      refs.playbackTime.textContent = "--";
      refs.playbackStatus.textContent = payload.fallbackReason || "当前没有可用的实时或历史数据";
      refs.timeSlider.max = "0";
      refs.timeSlider.value = "0";
      refs.boardList.innerHTML = `
        <article class="board-row">
          <div class="board-main">
            <strong>当前没有可用板块数据</strong>
            <span>${payload.fallbackReason || "请稍后刷新再试"}</span>
          </div>
        </article>
      `;
      refs.loadingState.textContent = payload.fallbackReason || "当前没有可用板块数据";
      await loadSourceStrategy(
        payload.fromSnapshot,
        payload.fromSnapshot ? "local-snapshot" : payload.source?.id || "none"
      );
      return;
    }

    refs.timeSlider.max = String(Math.max((payload.timeline?.length || 1) - 1, 0));

    const frameIndex =
      refresh || state.selectedDate === "today"
        ? Math.max((payload.timeline?.length || 1) - 1, 0)
        : Math.min(state.frameIndex, Math.max((payload.timeline?.length || 1) - 1, 0));

    setFrameIndex(frameIndex);

    const baseStatus = payload.fromSnapshot
      ? `历史快照 · ${payload.tradeDate}`
      : `已更新 · ${payload.updatedTime || payload.fetchedAt.slice(11, 16)}`;
    const statusNotes = [];

    if (payload.fallbackReason) {
      statusNotes.push(payload.fallbackReason);
    }

    if (payload.fromSnapshot && requestedLimit > actualLimit && actualLimit > 0) {
      statusNotes.push(`当前只有 ${actualLimit} 条可用快照`);
    }

    refs.loadingState.textContent = [baseStatus, ...statusNotes].join(" · ");
    await loadSourceStrategy(
      payload.fromSnapshot,
      payload.fromSnapshot ? "local-snapshot" : payload.source?.id || "eastmoney-live"
    );
  } catch (error) {
    refs.loadingState.textContent = "加载失败";
    refs.boardList.innerHTML = `
      <article class="board-row">
        <div class="board-main">
          <strong>数据获取失败</strong>
          <span>${error.message}</span>
        </div>
      </article>
    `;
    refs.strategyHint.textContent = "主图数据加载失败";
    refs.strategyList.innerHTML = "";
  }
}

function playTimeline() {
  if (!state.payload?.boards?.length) return;

  const maxIndex = Math.max(state.payload.timeline.length - 1, 0);

  if (state.frameIndex >= maxIndex) {
    state.frameIndex = 0;
  }

  state.playing = true;
  refs.playButton.textContent = "暂停";
  renderFrame();

  state.playTimer = setInterval(() => {
    if (state.frameIndex >= maxIndex) {
      stopPlayback();
      return;
    }

    state.frameIndex += 1;
    refs.timeSlider.value = String(state.frameIndex);
    renderFrame();
  }, 360);
}

refs.categoryGroup.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  state.category = button.dataset.category;
  state.selectedDate = "today";
  setActiveButton(refs.categoryGroup, "category", state.category);
  loadData();
});

refs.modeGroup.addEventListener("click", (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  state.mode = button.dataset.mode;
  state.selectedDate = "today";
  setActiveButton(refs.modeGroup, "mode", state.mode);
  loadData();
});

refs.limitSelect.addEventListener("change", (event) => {
  state.limit = Number(event.target.value);
  state.selectedDate = "today";
  loadData();
});

refs.policySelect.addEventListener("change", (event) => {
  state.policy = event.target.value;
  state.selectedDate = "today";
  loadData();
});

refs.dateSelect.addEventListener("change", (event) => {
  state.selectedDate = event.target.value;
  loadData();
});

refs.refreshButton.addEventListener("click", () => {
  state.selectedDate = "today";
  refs.dateSelect.value = "today";
  loadData({ refresh: true });
});

refs.playButton.addEventListener("click", () => {
  if (state.playing) {
    stopPlayback();
    refs.playbackStatus.textContent = `当前位置：显示从开盘到 ${refs.playbackTime.textContent} 的累计变化`;
    return;
  }
  playTimeline();
});

refs.timeSlider.addEventListener("input", (event) => {
  stopPlayback();
  setFrameIndex(Number(event.target.value));
});

refs.boardList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-board-code]");
  if (!row || !state.payload) return;
  loadConstituents(row.dataset.boardCode, row.dataset.boardName);
});

window.addEventListener("resize", () => {
  chart.resize();
  if (state.payload) {
    chart.setOption(buildChartOption(state.payload, state.frameIndex), true);
  }
});

chart.on("click", (params) => {
  if (!params?.seriesName || !state.payload) return;
  const board = state.payload.boards.find((item) => item.name === params.seriesName);
  if (board) {
    loadConstituents(board.code, board.name);
  }
});

setActiveButton(refs.categoryGroup, "category", state.category);
setActiveButton(refs.modeGroup, "mode", state.mode);
loadData();
