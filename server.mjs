import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const snapshotDir = path.join(__dirname, "data", "snapshots");
const constituentSnapshotDir = path.join(__dirname, "data", "constituents");
const constituentCheckpointDir = path.join(__dirname, "data", "constituent-checkpoints");
const tdxBridgePath = path.join(__dirname, "tdx_bridge.py");
const execFileAsync = promisify(execFile);

const PORT = Number(globalThis.process?.env?.PORT || 3100);
const TDX_HOME = globalThis.process?.env?.TDX_HOME || "C:\\new_tdx";
const TDX_PYTHON =
  globalThis.process?.env?.TDX_PYTHON ||
  "C:\\Users\\yao\\AppData\\Local\\Programs\\Python\\Python313\\python.exe";
const TDX_CACHE_DIR = path.join(TDX_HOME, "T0002", "hq_cache");
const TDX_LOCAL_FILES = {
  concepts: path.join(TDX_CACHE_DIR, "spblock.dat"),
  industries: path.join(TDX_HOME, "incon.dat"),
  industryMembers: path.join(TDX_CACHE_DIR, "tdxhy.cfg")
};

const EASTMONEY_HEADERS = {
  Referer: "https://data.eastmoney.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
};

const THS_HEADERS = {
  Referer: "https://q.10jqka.com.cn/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
};

const SINA_HEADERS = {
  Referer: "https://vip.stock.finance.sina.com.cn/moneyflow/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
};

const CATEGORY_MAP = {
  concept: { label: "概念", fs: "m:90+t:3" },
  industry: { label: "行业", fs: "m:90+t:2" },
  region: { label: "地域", fs: "m:90+t:1" }
};

const TODAY_FIELDS =
  "f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205,f124,f1,f13";
const SINA_CATEGORY_MAP = {
  concept: { fenlei: "1", supportsLiveFallback: true },
  industry: { fenlei: "0", supportsLiveFallback: true },
  region: { fenlei: null, supportsLiveFallback: false }
};
const THS_BOARD_CONFIG = {
  concept: {
    sampleUrl: "https://q.10jqka.com.cn/gn/index/field/addtime/order/desc/page/1/",
    boardUrl: (code, page = 1) =>
      `https://q.10jqka.com.cn/gn/detail/code/${code}/${page > 1 ? `page/${page}/` : ""}`
  },
  industry: {
    sampleUrl: "https://q.10jqka.com.cn/thshy/",
    boardUrl: (code, page = 1) =>
      `https://q.10jqka.com.cn/thshy/detail/code/${code}/${page > 1 ? `page/${page}/` : ""}`
  }
};

const SUPPORTED_LIMITS = [8, 12, 16];
const SUPPORTED_MODES = ["balanced", "inflow", "outflow"];

const cache = new Map();
const upstreamState = new Map();

const CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 3,
  cooldownMs: 45_000
};

const UPSTREAMS = {
  eastmoney: { label: "东方财富", timeoutMs: 12_000 },
  sina: { label: "新浪财经", timeoutMs: 12_000 },
  ths: { label: "同花顺", timeoutMs: 14_000 }
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    }[ext] || "application/octet-stream";

  readFile(filePath)
    .then((content) => {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    })
    .catch(() => {
      res.writeHead(404);
      res.end("Not found");
    });
}

function getCurrentDateInChina() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function getUpstreamRuntime(provider) {
  if (!upstreamState.has(provider)) {
    upstreamState.set(provider, {
      failures: 0,
      openUntil: 0,
      lastSuccessAt: 0,
      lastError: ""
    });
  }

  return upstreamState.get(provider);
}

function markUpstreamSuccess(provider) {
  const state = getUpstreamRuntime(provider);
  state.failures = 0;
  state.openUntil = 0;
  state.lastSuccessAt = Date.now();
  state.lastError = "";
}

function markUpstreamFailure(provider, error) {
  const state = getUpstreamRuntime(provider);
  state.failures += 1;
  state.lastError = error instanceof Error ? error.message : String(error);

  if (state.failures >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
    state.openUntil = Date.now() + CIRCUIT_BREAKER_CONFIG.cooldownMs;
  }
}

function assertCircuitClosed(provider) {
  const state = getUpstreamRuntime(provider);
  const now = Date.now();
  if (state.openUntil > now) {
    const retryAfterMs = state.openUntil - now;
    const error = new Error(`${provider} circuit open; retry after ${retryAfterMs}ms`);
    error.code = "CIRCUIT_OPEN";
    error.retryAfterMs = retryAfterMs;
    throw error;
  }
}

function getTransportDiagnostics() {
  return Object.entries(UPSTREAMS).map(([id, config]) => {
    const state = getUpstreamRuntime(id);
    return {
      id,
      label: config.label,
      type: "direct",
      failures: state.failures,
      openUntil: state.openUntil,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError
    };
  });
}

async function fetchResource(url, { provider, headers, parser, timeoutMs, maxAttempts = 3 }) {
  assertCircuitClosed(provider);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const effectiveTimeout = timeoutMs || UPSTREAMS[provider]?.timeoutMs || 12_000;
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Upstream request failed: ${response.status}`);
      }

      const payload = await parser(response);
      markUpstreamSuccess(provider);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delayMs = 1000 * 2 ** (attempt - 1) + randomBetween(0, 250);
        await sleep(delayMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  markUpstreamFailure(provider, lastError);
  throw lastError;
}

async function fetchJson(url, headers = EASTMONEY_HEADERS) {
  return fetchResource(url, {
    provider: "eastmoney",
    headers,
    parser: (response) => response.json(),
    timeoutMs: 12_000
  });
}

async function fetchText(url, { headers = THS_HEADERS, encoding = "utf-8" } = {}) {
  return fetchResource(url, {
    provider: "ths",
    headers,
    parser: async (response) => {
      const buffer = Buffer.from(await response.arrayBuffer());
      return encoding === "utf-8"
        ? buffer.toString("utf8")
        : new TextDecoder(encoding).decode(buffer);
    },
    timeoutMs: 14_000
  });
}

async function fetchSinaJson(url) {
  return fetchResource(url, {
    provider: "sina",
    headers: SINA_HEADERS,
    parser: async (response) => {
      const text = await response.text();
      return JSON.parse(text);
    },
    timeoutMs: 12_000
  });
}

async function callTdxBridge(action, args = {}, timeoutMs = 20_000) {
  if (!existsSync(tdxBridgePath)) {
    return {
      ok: false,
      available: false,
      reason: "bridge_missing",
      message: "tdx_bridge.py is missing"
    };
  }

  try {
    const { stdout } = await execFileAsync(
      TDX_PYTHON,
      [tdxBridgePath, action, JSON.stringify(args)],
      {
        cwd: __dirname,
        env: {
          ...globalThis.process.env,
          TDX_HOME,
          PYTHONUTF8: "1"
        },
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      }
    );
    return JSON.parse(stdout.trim());
  } catch (error) {
    return {
      ok: false,
      available: false,
      reason: error?.code === "ENOENT" ? "python_missing" : "bridge_failed",
      message: error instanceof Error ? error.message : String(error),
      tdxHome: TDX_HOME,
      python: TDX_PYTHON
    };
  }
}

async function readGbkFile(filePath) {
  const buffer = await readFile(filePath);
  return new TextDecoder("gbk").decode(buffer);
}

function normalizeTdxStockCode(rawCode, marketHint = "") {
  const text = String(rawCode || "").trim();
  const market = String(marketHint || "").trim();
  const code = text.length === 7 ? text.slice(1) : text;
  const embeddedMarket = text.length === 7 ? text[0] : market;
  const suffix = embeddedMarket === "1" ? "SH" : embeddedMarket === "2" ? "BJ" : "SZ";
  return /^\d{6}$/.test(code) ? `${code}.${suffix}` : "";
}

function isAshareCode(code) {
  return /^(?:00[0-3]|30[01])\d{3}\.SZ$/.test(code) ||
    /^(?:60[0135]|68[89])\d{3}\.SH$/.test(code) ||
    /^(?:4|8|9)\d{5}\.BJ$/.test(code);
}

async function getTdxLocalFileStatus() {
  const files = await Promise.all(
    Object.entries(TDX_LOCAL_FILES).map(async ([id, filePath]) => {
      if (!existsSync(filePath)) {
        return { id, path: filePath, available: false, updatedAt: null };
      }
      const { stat } = await import("node:fs/promises");
      const info = await stat(filePath);
      return {
        id,
        path: filePath,
        available: true,
        updatedAt: info.mtime.toISOString(),
        size: info.size
      };
    })
  );
  return {
    available: files.every((file) => file.available),
    files,
    latestUpdatedAt: files
      .map((file) => file.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null
  };
}

async function readTdxLocalConcepts() {
  const text = await readGbkFile(TDX_LOCAL_FILES.concepts);
  const sectors = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      current = { code: line.slice(1), name: line.slice(1), category: "concept", stocks: [] };
      sectors.push(current);
      continue;
    }
    const code = normalizeTdxStockCode(line);
    if (current && code) current.stocks.push(code);
  }

  return sectors;
}

async function readTdxLocalIndustries() {
  const [definitionText, memberText] = await Promise.all([
    readGbkFile(TDX_LOCAL_FILES.industries),
    readGbkFile(TDX_LOCAL_FILES.industryMembers)
  ]);
  const industryNames = new Map();
  let inTdxIndustrySection = false;

  for (const rawLine of definitionText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "#TDXNHY") {
      inTdxIndustrySection = true;
      continue;
    }
    if (inTdxIndustrySection && line === "######") break;
    if (!inTdxIndustrySection || !line || line.startsWith("#")) continue;
    const [code, name] = line.split("|");
    if (code && name) industryNames.set(code.trim(), name.trim());
  }

  const sectors = new Map();
  for (const rawLine of memberText.split(/\r?\n/)) {
    const fields = rawLine.trim().split("|");
    if (fields.length < 3) continue;
    const [market, rawCode, industryCode] = fields;
    if (!industryCode?.startsWith("T")) continue;
    const stockCode = normalizeTdxStockCode(rawCode, market);
    if (!stockCode) continue;
    if (!sectors.has(industryCode)) {
      sectors.set(industryCode, {
        code: industryCode,
        name: industryNames.get(industryCode) || industryCode,
        category: "industry",
        stocks: []
      });
    }
    sectors.get(industryCode).stocks.push(stockCode);
  }
  return [...sectors.values()];
}

async function getTdxLocalSectors(category) {
  const sectors =
    category === "industry" ? await readTdxLocalIndustries() : await readTdxLocalConcepts();
  return sectors
    .map((sector) => ({
      ...sector,
      stocks: [...new Set(sector.stocks)].filter(isAshareCode)
    }))
    .filter((sector) => sector.stocks.length > 0)
    .sort((left, right) => right.stocks.length - left.stocks.length);
}

async function withCache(key, ttlMs, loader, bypass = false) {
  const now = Date.now();
  const hit = cache.get(key);

  if (!bypass && hit && hit.expiresAt > now) {
    return hit.value;
  }

  const pending = loader()
    .then((value) => {
      cache.set(key, { value, expiresAt: now + ttlMs });
      return value;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });

  cache.set(key, { value: pending, expiresAt: now + ttlMs });
  return pending;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildUrl(base, params) {
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

function dedupeByCode(items) {
  const seen = new Map();
  for (const item of items) {
    if (!item?.code) continue;
    seen.set(item.code, item);
  }
  return [...seen.values()];
}

function stripTags(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#37;/g, "%")
    .replace(/&#40;/g, "(")
    .replace(/&#41;/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLookupName(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[-_/]/g, "")
    .toLowerCase();
}

function parseNumeric(value) {
  const text = stripTags(value).replace(/,/g, "");
  if (!text || text === "--") {
    return null;
  }

  const match = text.match(/^(-?\d+(?:\.\d+)?)(万|亿)?$/);
  if (!match) {
    return Number(text);
  }

  const base = Number(match[1]);
  const unit = match[2];

  if (unit === "亿") return base * 1e8;
  if (unit === "万") return base * 1e4;
  return base;
}

function normalizeBoard(item) {
  return {
    code: item.f12,
    name: item.f14,
    latest: Number(item.f2 ?? 0),
    changePercent: Number(item.f3 ?? 0),
    mainNet: Number(item.f62 ?? 0),
    mainNetRatio: Number(item.f184 ?? 0),
    superLargeNet: Number(item.f66 ?? 0),
    superLargeRatio: Number(item.f69 ?? 0),
    largeNet: Number(item.f72 ?? 0),
    largeRatio: Number(item.f75 ?? 0),
    mediumNet: Number(item.f78 ?? 0),
    mediumRatio: Number(item.f81 ?? 0),
    smallNet: Number(item.f84 ?? 0),
    smallRatio: Number(item.f87 ?? 0),
    leaderName: item.f204 || "",
    leaderCode: item.f205 || "",
    updatedAt: item.f124 || ""
  };
}

function normalizeSinaBoard(item) {
  return {
    code: item.category,
    name: item.name,
    latest: Number(item.avg_price ?? 0),
    changePercent: Number(item.avg_changeratio ?? 0) * 100,
    mainNet: Number(item.netamount ?? 0),
    mainNetRatio: Number(item.ratioamount ?? 0) * 100,
    superLargeNet: 0,
    superLargeRatio: Number(item.r0_ratio ?? 0) * 100,
    largeNet: 0,
    largeRatio: 0,
    mediumNet: 0,
    mediumRatio: 0,
    smallNet: 0,
    smallRatio: Number(item.r3_ratio ?? 0) * 100,
    leaderName: item.ts_name || "",
    leaderCode: item.ts_symbol || "",
    updatedAt: ""
  };
}

async function fetchBoardRanking(category, { bypassCache = false } = {}) {
  const categoryInfo = CATEGORY_MAP[category] || CATEGORY_MAP.concept;
  const cacheKey = `ranking:${category}`;

  return withCache(
    cacheKey,
    15_000,
    async () => {
      const url = buildUrl("https://push2.eastmoney.com/api/qt/clist/get", {
        pn: "1",
        pz: "2000",
        po: "1",
        np: "1",
        fltt: "2",
        invt: "2",
        fid: "f62",
        ut: "8dec03ba335b81bf4ebdf7b29ec27d15",
        fs: categoryInfo.fs,
        fields: TODAY_FIELDS
      });

      const payload = await fetchJson(url);
      const items = payload?.data?.diff || [];
      return items.map(normalizeBoard).sort((a, b) => b.mainNet - a.mainNet);
    },
    bypassCache
  );
}

async function fetchSinaBoardRankingPage(
  category,
  { asc = 0, page = 1, num = 80, bypassCache = false } = {}
) {
  const config = SINA_CATEGORY_MAP[category];
  if (!config?.supportsLiveFallback || !config.fenlei) {
    throw new Error(`Sina live board ranking is unavailable for category: ${category}`);
  }

  return withCache(
    `sina:ranking:${category}:${asc}:${page}:${num}`,
    20_000,
    async () => {
      const url = buildUrl(
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk",
        {
          page: String(page),
          num: String(num),
          sort: "netamount",
          asc: String(asc),
          fenlei: config.fenlei
        }
      );
      const payload = await fetchSinaJson(url);
      const items = Array.isArray(payload) ? payload : [];
      return items.map(normalizeSinaBoard);
    },
    bypassCache
  );
}

function parseThsBoardCodeMap(html, category) {
  const pattern =
    category === "industry"
      ? /<a[^>]+href="https?:\/\/q\.10jqka\.com\.cn\/thshy\/detail\/code\/(\d+)\/?"[^>]*>([^<]+)<\/a>/g
      : /<a[^>]+href="https?:\/\/q\.10jqka\.com\.cn\/gn\/detail\/code\/(\d+)\/?"[^>]*>([^<]+)<\/a>/g;
  const map = new Map();

  for (const match of html.matchAll(pattern)) {
    const name = stripTags(match[2]);
    if (!name) continue;
    map.set(normalizeLookupName(name), {
      name,
      code: match[1]
    });
  }

  return map;
}

async function fetchThsBoardCodeMap(category, { bypassCache = false } = {}) {
  if (!(category in THS_BOARD_CONFIG)) {
    return new Map();
  }

  return withCache(
    `ths:board-map:${category}`,
    12 * 60 * 60 * 1000,
    async () => {
      const html = await fetchText(THS_BOARD_CONFIG[category].sampleUrl, {
        headers: THS_HEADERS,
        encoding: "gbk"
      });
      return parseThsBoardCodeMap(html, category);
    },
    bypassCache
  );
}

async function resolveThsBoardCode(category, boardName, { bypassCache = false } = {}) {
  const boardMap = await fetchThsBoardCodeMap(category, { bypassCache });
  const normalized = normalizeLookupName(boardName);
  const direct = boardMap.get(normalized);
  if (direct) {
    return direct;
  }

  const aliasCandidates = [
    boardName,
    boardName.replace(/概念$/u, ""),
    `${boardName}概念`
  ]
    .filter(Boolean)
    .map(normalizeLookupName);

  for (const candidate of aliasCandidates) {
    const hit = boardMap.get(candidate);
    if (hit) {
      return hit;
    }
  }

  throw new Error(`Unable to map board name to THS source: ${boardName}`);
}

function parseThsTotalPages(html) {
  const match = html.match(/<span class="page_info">\s*\d+\s*\/\s*(\d+)\s*<\/span>/);
  return Number(match?.[1] || 1);
}

function parseThsConstituents(html) {
  const tbodyMatch = html.match(
    /<table[^>]+class="m-table m-pager-table"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/
  );
  const tbody = tbodyMatch?.[1] || "";
  const rows = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];

  return rows
    .map((rowMatch) => [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]))
    .filter((cells) => cells.length >= 14)
    .map((cells) => ({
      rank: Number(stripTags(cells[0])) || null,
      code: stripTags(cells[1]),
      name: stripTags(cells[2]),
      latest: parseNumeric(cells[3]),
      changePercent: parseNumeric(cells[4]) ?? 0,
      changeAmount: parseNumeric(cells[5]),
      speedPercent: parseNumeric(cells[6]),
      turnoverRate: parseNumeric(cells[7]),
      volumeRatio: parseNumeric(cells[8]),
      amplitude: parseNumeric(cells[9]),
      turnoverAmount: parseNumeric(cells[10]),
      turnoverAmountLabel: stripTags(cells[10]),
      floatSharesLabel: stripTags(cells[11]),
      floatMarketValue: parseNumeric(cells[12]),
      floatMarketValueLabel: stripTags(cells[12]),
      peTtm: parseNumeric(cells[13])
    }));
}

async function fetchThsBoardConstituents(category, boardName, { bypassCache = false } = {}) {
  const cacheKey = `ths:constituents:${category}:${boardName}`;

  return withCache(
    cacheKey,
    10 * 60 * 1000,
    async () => {
      const resolved = await resolveThsBoardCode(category, boardName, { bypassCache });
      const config = THS_BOARD_CONFIG[category];
      const checkpoint = !bypassCache
        ? await readConstituentCheckpoint({ category, boardCode: resolved.code }).catch(() => null)
        : null;

      let totalPages = checkpoint?.totalPages || 0;
      let allRows = dedupeByCode(checkpoint?.rows || []);
      let nextPage = checkpoint?.lastSuccessfulPage ? checkpoint.lastSuccessfulPage + 1 : 1;
      const resumedFromPage = nextPage;

      if (!checkpoint || !checkpoint.totalPages || !checkpoint.lastSuccessfulPage) {
        const firstPageHtml = await fetchText(config.boardUrl(resolved.code, 1), {
          headers: THS_HEADERS,
          encoding: "gbk"
        });
        totalPages = parseThsTotalPages(firstPageHtml);
        allRows = dedupeByCode(parseThsConstituents(firstPageHtml));
        nextPage = 2;
        await writeConstituentCheckpoint({
          category,
          boardCode: resolved.code,
          boardName: resolved.name,
          totalPages,
          lastSuccessfulPage: 1,
          rows: allRows,
          updatedAt: new Date().toISOString()
        });
      }

      for (let page = nextPage; page <= totalPages; page += 1) {
        try {
          await sleep(randomBetween(220, 520));
          const pageHtml = await fetchText(config.boardUrl(resolved.code, page), {
            headers: THS_HEADERS,
            encoding: "gbk"
          });
          const pageRows = parseThsConstituents(pageHtml);
          allRows = dedupeByCode([...allRows, ...pageRows]);
          await writeConstituentCheckpoint({
            category,
            boardCode: resolved.code,
            boardName: resolved.name,
            totalPages,
            lastSuccessfulPage: page,
            rows: allRows,
            updatedAt: new Date().toISOString()
          });
        } catch (error) {
          const interruptedError = new Error(
            `THS constituent fetch interrupted at page ${page}/${totalPages}`
          );
          interruptedError.cause = error;
          interruptedError.partialCheckpoint = {
            category,
            boardCode: resolved.code,
            boardName: resolved.name,
            totalPages,
            lastSuccessfulPage: Math.max(page - 1, 1),
            nextPage: page,
            rows: allRows
          };
          throw interruptedError;
        }
      }

      await clearConstituentCheckpoint({ category, boardCode: resolved.code });

      return {
        boardName: resolved.name,
        thsCode: resolved.code,
        totalPages,
        resumedFromPage,
        resumed: Boolean(checkpoint?.lastSuccessfulPage),
        constituents: allRows
      };
    },
    bypassCache
  );
}

function pickBoards(boards, mode, limit) {
  const safeLimit = Math.max(4, Math.min(limit, 20));

  if (mode === "inflow") {
    return boards.slice(0, safeLimit);
  }

  if (mode === "outflow") {
    return [...boards].sort((a, b) => a.mainNet - b.mainNet).slice(0, safeLimit);
  }

  const positiveCount = Math.ceil(safeLimit / 2);
  const negativeCount = Math.floor(safeLimit / 2);
  const positives = boards.filter((item) => item.mainNet >= 0).slice(0, positiveCount);
  const negatives = [...boards]
    .filter((item) => item.mainNet < 0)
    .sort((a, b) => a.mainNet - b.mainNet)
    .slice(0, negativeCount);
  const selected = [...positives, ...negatives];
  const selectedCodes = new Set(selected.map((item) => item.code));

  if (selected.length < safeLimit) {
    const remainder = boards.filter((item) => !selectedCodes.has(item.code));
    const fill = [...remainder]
      .sort((a, b) => a.mainNet - b.mainNet)
      .slice(0, safeLimit - selected.length);
    selected.push(...fill);
  }

  return selected.sort((a, b) => b.mainNet - a.mainNet);
}

async function fetchIntradayFlow(boardCode, { bypassCache = false } = {}) {
  const cacheKey = `intraday:${boardCode}`;

  return withCache(
    cacheKey,
    15_000,
    async () => {
      const url = buildUrl("https://push2.eastmoney.com/api/qt/stock/fflow/kline/get", {
        lmt: "0",
        klt: "1",
        secid: `90.${boardCode}`,
        fields1: "f1,f2,f3,f7",
        fields2: "f51,f52,f53,f54,f55,f56",
        ut: "fa5fd1943c7b386f172d6893dbfba10b"
      });

      const payload = await fetchJson(url);
      const rawLines = payload?.data?.klines || [];
      const series = rawLines
        .map((line) => {
          const [timestamp, mainNet, smallNet, mediumNet, largeNet, superLargeNet] = line.split(",");
          return {
            timestamp,
            time: timestamp.slice(11, 16),
            mainNet: Number(mainNet),
            smallNet: Number(smallNet),
            mediumNet: Number(mediumNet),
            largeNet: Number(largeNet),
            superLargeNet: Number(superLargeNet)
          };
        })
        .filter((point) => point.time);

      return {
        boardCode,
        boardName: payload?.data?.name || boardCode,
        tradeDate: series[0]?.timestamp?.slice(0, 10) || "",
        updatedTime: series.at(-1)?.time || "",
        series
      };
    },
    bypassCache
  );
}

async function fetchSinaIntradayFlow(boardCode, { bypassCache = false } = {}) {
  const cacheKey = `sina:intraday:${boardCode}`;

  return withCache(
    cacheKey,
    20_000,
    async () => {
      const url = buildUrl(
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssx_bkzj_fszs",
        {
          page: "1",
          num: "241",
          bankuai: boardCode,
          sort: "time"
        }
      );

      const payload = await fetchSinaJson(url);
      const rawSeries = Array.isArray(payload?.[1]) ? payload[1] : [];
      const series = rawSeries
        .map((point) => {
          const timestamp = `${point.opendate || ""} ${point.ticktime || ""}`.trim();
          return {
            timestamp,
            time: String(point.ticktime || "").slice(0, 5),
            mainNet: Number(point.netamount ?? 0),
            smallNet: 0,
            mediumNet: 0,
            largeNet: 0,
            superLargeNet: 0
          };
        })
        .filter((point) => point.time)
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

      return {
        boardCode,
        boardName: boardCode,
        tradeDate: series[0]?.timestamp?.slice(0, 10) || "",
        updatedTime: series.at(-1)?.time || "",
        series
      };
    },
    bypassCache
  );
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function loop() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => loop());
  await Promise.all(workers);
  return results;
}

async function runWithConcurrencySettled(items, limit, worker) {
  const settled = await runWithConcurrency(items, limit, async (item, index) => {
    try {
      return { status: "fulfilled", value: await worker(item, index) };
    } catch (error) {
      return {
        status: "rejected",
        item,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  });

  return {
    values: settled.filter((item) => item.status === "fulfilled").map((item) => item.value),
    errors: settled.filter((item) => item.status === "rejected")
  };
}

function getPayloadSourceId(payload) {
  if (payload?.source?.id) return payload.source.id;
  const provider = String(payload?.source?.provider || "").toLowerCase();
  if (provider.includes("eastmoney") || provider.includes("东方财富")) return "eastmoney-live";
  if (provider.includes("sina") || provider.includes("新浪")) return "sina-live";
  if (provider.includes("tdx") || provider.includes("通达信")) return "tdx-live";
  return "unknown";
}

function snapshotFileName({ date, category, mode, limit, sourceId = "unknown" }) {
  return `${date}__${category}__${mode}__${limit}__${sourceId}.json`;
}

async function listSnapshotEntries() {
  await ensureSnapshotDir();
  const entries = await readdir(snapshotDir, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const parts = entry.name.replace(/\.json$/i, "").split("__");
        const [date, category, mode, limitText, fileSourceId] = parts;
        let sourceId = fileSourceId || "";

        if (!sourceId) {
          try {
            const content = await readFile(path.join(snapshotDir, entry.name), "utf8");
            sourceId = getPayloadSourceId(JSON.parse(content));
          } catch {
            sourceId = "unknown";
          }
        }

        return {
          fileName: entry.name,
          date,
          category,
          mode,
          limit: Number(limitText),
          sourceId
        };
      })
  );
}

async function ensureSnapshotDir() {
  await mkdir(snapshotDir, { recursive: true });
}

async function ensureConstituentSnapshotDir() {
  await mkdir(constituentSnapshotDir, { recursive: true });
}

async function ensureConstituentCheckpointDir() {
  await mkdir(constituentCheckpointDir, { recursive: true });
}

async function writeSnapshot(payload) {
  await ensureSnapshotDir();
  const filePath = path.join(
    snapshotDir,
    snapshotFileName({
      date: payload.tradeDate,
      category: payload.category,
      mode: payload.mode,
      limit: payload.limit,
      sourceId: getPayloadSourceId(payload)
    })
  );
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readSnapshot({ date, category, mode, limit, sourceId = "unknown" }) {
  const filePath = path.join(
    snapshotDir,
    snapshotFileName({ date, category, mode, limit, sourceId })
  );
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

function constituentSnapshotFileName({ date, category, boardCode }) {
  return `${date}__${category}__${boardCode}.json`;
}

function constituentCheckpointFileName({ category, boardCode }) {
  return `${category}__${boardCode}.json`;
}

async function writeConstituentSnapshot(payload) {
  await ensureConstituentSnapshotDir();
  const filePath = path.join(
    constituentSnapshotDir,
    constituentSnapshotFileName({
      date: payload.tradeDate,
      category: payload.category,
      boardCode: payload.boardCode
    })
  );
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readLatestConstituentSnapshot({ category, boardCode }) {
  await ensureConstituentSnapshotDir();
  const entries = await readdir(constituentSnapshotDir, { withFileTypes: true });
  const matched = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/i, ""))
    .map((name) => {
      const [date, fileCategory, fileBoardCode] = name.split("__");
      return {
        date,
        category: fileCategory,
        boardCode: fileBoardCode,
        fileName: `${name}.json`
      };
    })
    .filter((item) => item.category === category && item.boardCode === boardCode)
    .sort((left, right) => right.date.localeCompare(left.date));

  if (!matched.length) {
    throw new Error("No constituent snapshot found");
  }

  const content = await readFile(path.join(constituentSnapshotDir, matched[0].fileName), "utf8");
  return JSON.parse(content);
}

async function writeConstituentCheckpoint(payload) {
  await ensureConstituentCheckpointDir();
  const filePath = path.join(
    constituentCheckpointDir,
    constituentCheckpointFileName({
      category: payload.category,
      boardCode: payload.boardCode
    })
  );
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readConstituentCheckpoint({ category, boardCode }) {
  await ensureConstituentCheckpointDir();
  const filePath = path.join(
    constituentCheckpointDir,
    constituentCheckpointFileName({ category, boardCode })
  );

  if (!existsSync(filePath)) {
    return null;
  }

  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function clearConstituentCheckpoint({ category, boardCode }) {
  await ensureConstituentCheckpointDir();
  const filePath = path.join(
    constituentCheckpointDir,
    constituentCheckpointFileName({ category, boardCode })
  );

  if (existsSync(filePath)) {
    await unlink(filePath).catch(() => undefined);
  }
}

async function listAvailableDates({ category, mode, allowedSources = null }) {
  const entries = await listSnapshotEntries();
  const matched = entries
    .filter(
      (item) =>
        item.category === category &&
        item.mode === mode &&
        (!allowedSources || allowedSources.includes(item.sourceId))
    )
    .map((item) => item.date)
    .sort((left, right) => right.localeCompare(left));

  return [...new Set(matched)];
}

async function getSnapshotCoverage({ allowedSources = null } = {}) {
  const coverage = {
    concept: { balanced: [], inflow: [], outflow: [] },
    industry: { balanced: [], inflow: [], outflow: [] },
    region: { balanced: [], inflow: [], outflow: [] }
  };

  const latestDateByGroup = {};
  const entries = await listSnapshotEntries();

  for (const entry of entries) {
    const { date, category, mode, limit } = entry;
    if (allowedSources && !allowedSources.includes(entry.sourceId)) continue;
    if (!(category in coverage)) continue;
    if (!SUPPORTED_MODES.includes(mode)) continue;
    if (!Number.isFinite(limit)) continue;

    if (!coverage[category][mode].includes(limit)) {
      coverage[category][mode].push(limit);
    }

    const groupKey = `${category}:${mode}`;
    if (!latestDateByGroup[groupKey] || date > latestDateByGroup[groupKey]) {
      latestDateByGroup[groupKey] = date;
    }
  }

  for (const category of Object.keys(coverage)) {
    for (const mode of SUPPORTED_MODES) {
      coverage[category][mode].sort((left, right) => left - right);
    }
  }

  return {
    coverage,
    latestDateByGroup
  };
}

async function buildSourceStrategyPayload({ category, mode, limit, usingSnapshot = false }) {
  const { coverage, latestDateByGroup } = await getSnapshotCoverage();
  const availableLimits = coverage[category]?.[mode] || [];
  const exactMatch = availableLimits.includes(limit);
  const bestFallbackLimit = availableLimits.filter((item) => item <= limit).at(-1) || null;
  const latestDate = latestDateByGroup[`${category}:${mode}`] || null;

  return {
    category,
    mode,
    requestedLimit: limit,
    snapshot: {
      availableLimits,
      exactMatch,
      bestFallbackLimit,
      latestDate
    },
    sources: [
      {
        id: "eastmoney-live",
        name: "东方财富板块资金",
        role: "主源",
        status: usingSnapshot ? "degraded" : "active",
        capabilities: "板块排行 + 日内主力资金曲线",
        note: usingSnapshot
          ? "当前主图已回退到本地快照，说明主源刚刚拉取失败"
          : "当前主图优先走这个实时源"
      },
      {
        id: "local-snapshot",
        name: "本地历史快照",
        role: "兜底",
        status: availableLimits.length ? "active" : "empty",
        capabilities: "历史回看 + 请求失败兜底",
        note: availableLimits.length
          ? `当前 ${category}/${mode} 已覆盖 ${availableLimits.join(" / ")} 条`
          : `当前 ${category}/${mode} 还没有可用快照`
      },
      {
        id: "ths-constituents",
        name: "同花顺板块详情页",
        role: "成分股",
        status: category === "region" ? "partial" : "active",
        capabilities: "概念/行业成分股明细",
        note:
          category === "region"
            ? "地域板块成分股还没接上稳定来源"
            : "已接入点击板块查看成分股"
      },
      {
        id: "sina-preview",
        name: "新浪财经板块资金",
        role: "候补规划",
        status: "preview",
        capabilities: "可作为概念/行业排行候补源",
        note: "先做合法多来源冗余，不做 IP 绕过或风控规避"
      }
    ],
    recommendation: exactMatch
      ? `当前组合已有 ${limit} 条快照，可在主源失败时完整兜底`
      : bestFallbackLimit
        ? `当前请求 ${limit} 条，但本地只有 ${bestFallbackLimit} 条快照，所以失败时会回退到 ${bestFallbackLimit} 条`
        : `当前 ${category}/${mode} 组合还没有可用快照，建议先在主源正常时预热一轮`
  };
}

async function buildSourceStrategyPayloadV2({
  category,
  mode,
  limit,
  policy = "taxonomy",
  usingSnapshot = false,
  activeSource = "eastmoney-live"
}) {
  const allowedSources = policy === "taxonomy" ? ["eastmoney-live"] : null;
  const { coverage, latestDateByGroup } = await getSnapshotCoverage({ allowedSources });
  const availableLimits = coverage[category]?.[mode] || [];
  const exactMatch = availableLimits.includes(limit);
  const bestFallbackLimit = availableLimits.filter((item) => item <= limit).at(-1) || null;
  const latestDate = latestDateByGroup[`${category}:${mode}`] || null;
  const sinaSupported = Boolean(SINA_CATEGORY_MAP[category]?.supportsLiveFallback);

  let recommendation = "";
  if (policy === "taxonomy") {
    recommendation =
      activeSource === "local-snapshot"
        ? "当前是东财体系优先模式：实时失败后只回退到同体系历史快照，不切新浪，方便学习同一套板块口径。"
        : "当前是东财体系优先模式：优先保证板块划分口径一致，更适合复盘和学习。";
  } else if (activeSource === "sina-live") {
    recommendation = "当前正在使用新浪财经实时候补源，东方财富失败后已自动切换。";
  } else if (activeSource === "local-snapshot") {
    recommendation = exactMatch
      ? `当前组合已有 ${limit} 条本地快照，实时源失败时可以完整兜底。`
      : bestFallbackLimit
        ? `当前请求 ${limit} 条，但本地只有 ${bestFallbackLimit} 条快照，所以失败时会回退到 ${bestFallbackLimit} 条。`
        : `当前 ${category}/${mode} 组合还没有可用快照，建议在实时源正常时先预热一轮。`;
  } else {
    recommendation = "当前主图优先走东方财富实时源；失败时会先尝试新浪财经，再退回本地快照。";
  }

  return {
    category,
    mode,
    requestedLimit: limit,
    snapshot: {
      availableLimits,
      exactMatch,
      bestFallbackLimit,
      latestDate
    },
    sources: [
      {
        id: "eastmoney-live",
        name: "东方财富板块资金",
        role: "主源",
        status:
          activeSource === "eastmoney-live"
            ? "active"
            : usingSnapshot
              ? "degraded"
              : "standby",
        capabilities: "板块排行 + 日内主力资金曲线",
        note:
          activeSource === "eastmoney-live"
            ? "当前主图正在使用东方财富实时数据。"
            : "一旦主源失败，会优先切到新浪财经候补源。"
      },
      {
        id: "sina-live",
        name: "新浪财经板块资金",
        role: "候补实时源",
        status:
          policy === "taxonomy"
            ? "disabled"
            : !sinaSupported
              ? "unsupported"
              : activeSource === "sina-live"
                ? "active"
                : "standby",
        capabilities: "概念/行业板块排行 + 板块分时资金",
        note: !sinaSupported
          ? "当前只给概念、行业接入了新浪实时候补，地域暂不支持。"
          : "东方财富失败时会自动切过来，继续拉当天主图。"
      },
      {
        id: "local-snapshot",
        name: "本地历史快照",
        role: "最终兜底",
        status:
          activeSource === "local-snapshot"
            ? "active"
            : availableLimits.length
              ? "standby"
              : "empty",
        capabilities: "历史回看 + 实时失败兜底",
        note: availableLimits.length
          ? `当前 ${category}/${mode} 已覆盖 ${availableLimits.join(" / ")} 条快照。`
          : `当前 ${category}/${mode} 还没有可用快照。`
      },
      {
        id: "ths-constituents",
        name: "同花顺板块详情页",
        role: "成分股来源",
        status: category === "region" ? "partial" : "active",
        capabilities: "概念/行业成分股明细",
        note:
          category === "region"
            ? "地域板块成分股还没有接上稳定来源。"
            : "点击板块后按需加载成分股，减少上游请求压力。"
      }
    ],
    recommendation
  };
}

async function readSnapshotBestMatch({
  category,
  mode,
  date,
  preferredLimit,
  allowModeFallback = false,
  allowedSources = null
}) {
  const entries = await listSnapshotEntries();
  const matched = entries
    .filter(
      (item) =>
        item.category === category &&
        (!mode || allowModeFallback || item.mode === mode) &&
        (!date || item.date === date) &&
        (!allowedSources || allowedSources.includes(item.sourceId))
    )
    .sort((left, right) => {
      if (mode) {
        const leftModePenalty = left.mode === mode ? 0 : 1;
        const rightModePenalty = right.mode === mode ? 0 : 1;
        if (leftModePenalty !== rightModePenalty) {
          return leftModePenalty - rightModePenalty;
        }
      }

      if (left.date !== right.date) {
        return right.date.localeCompare(left.date);
      }

      const leftDistance = Math.abs(left.limit - preferredLimit);
      const rightDistance = Math.abs(right.limit - preferredLimit);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      return left.limit - right.limit;
    });

  if (!matched.length) {
    throw new Error("No matching snapshot found");
  }

  const best = matched[0];
  const content = await readFile(path.join(snapshotDir, best.fileName), "utf8");
  const payload = JSON.parse(content);
  payload.snapshotMode = best.mode;
  payload.snapshotSourceId = best.sourceId;
  if (mode && Array.isArray(payload.boards)) {
    payload.boards = pickBoards(payload.boards, mode, preferredLimit);
    payload.mode = mode;
  }
  payload.limit = payload.boards?.length || best.limit;
  return payload;
}

async function buildLiveSectorPayload({ category, mode, limit, refresh }) {
  const boards = await fetchBoardRanking(category, { bypassCache: refresh });
  const selectedBoards = pickBoards(boards, mode, limit);
  const { values: flows, errors: flowErrors } = await runWithConcurrencySettled(
    selectedBoards,
    2,
    async (board) => {
    const intraday = await fetchIntradayFlow(board.code, { bypassCache: refresh });
    return {
      ...board,
      intraday
    };
    }
  );

  if (!flows.length) {
    throw new Error(`Eastmoney intraday flow failed for all ${selectedBoards.length} boards`);
  }

  const timeline = flows[0]?.intraday?.series?.map((point) => point.time) || [];
  const tradeDate = flows.find((item) => item.intraday.tradeDate)?.intraday.tradeDate || getCurrentDateInChina();
  const updatedTime = flows.find((item) => item.intraday.updatedTime)?.intraday.updatedTime || "";

  const payload = {
    category,
    categoryLabel: CATEGORY_MAP[category]?.label || CATEGORY_MAP.concept.label,
    mode,
    requestedLimit: limit,
    limit: selectedBoards.length,
    fetchedAt: new Date().toISOString(),
    tradeDate,
    currentDate: getCurrentDateInChina(),
    updatedTime,
    timeline,
    fromSnapshot: false,
    partial: flowErrors.length > 0,
    partialFailures: flowErrors.map((item) => ({
      code: item.item?.code,
      name: item.item?.name,
      reason: item.reason
    })),
    source: {
      id: "eastmoney-live",
      provider: "东方财富公开网页接口",
      boardFlowPage: "https://data.eastmoney.com/bkzj/",
      note: "数据仅供参考，不构成投资建议。"
    },
    boards: flows.map((item) => ({
      code: item.code,
      name: item.name,
      latest: item.latest,
      changePercent: item.changePercent,
      mainNet: item.mainNet,
      mainNetRatio: item.mainNetRatio,
      leaderName: item.leaderName,
      leaderCode: item.leaderCode,
      series: item.intraday.series,
      updatedTime: item.intraday.updatedTime
    }))
  };

  await writeSnapshot(payload);
  payload.availableDates = await listAvailableDates({
    category,
    mode
  });

  return payload;
}

async function buildSinaLiveSectorPayload({
  category,
  mode,
  limit,
  refresh,
  triggerError
}) {
  const config = SINA_CATEGORY_MAP[category];
  if (!config?.supportsLiveFallback) {
    throw new Error(`Sina live fallback is unavailable for category: ${category}`);
  }

  const desiredCount = Math.max(limit * 3, 48);
  let rankingPool = [];

  if (mode === "outflow") {
    rankingPool = await fetchSinaBoardRankingPage(category, {
      asc: 1,
      num: desiredCount,
      bypassCache: refresh
    });
  } else if (mode === "inflow") {
    rankingPool = await fetchSinaBoardRankingPage(category, {
      asc: 0,
      num: desiredCount,
      bypassCache: refresh
    });
  } else {
    const [topBoards, bottomBoards] = await Promise.all([
      fetchSinaBoardRankingPage(category, {
        asc: 0,
        num: desiredCount,
        bypassCache: refresh
      }),
      fetchSinaBoardRankingPage(category, {
        asc: 1,
        num: desiredCount,
        bypassCache: refresh
      })
    ]);
    rankingPool = dedupeByCode([...topBoards, ...bottomBoards]).sort(
      (left, right) => right.mainNet - left.mainNet
    );
  }

  const selectedBoards = pickBoards(rankingPool, mode, limit);
  const { values: flows, errors: flowErrors } = await runWithConcurrencySettled(
    selectedBoards,
    3,
    async (board) => {
    const intraday = await fetchSinaIntradayFlow(board.code, { bypassCache: refresh });
    return {
      ...board,
      intraday
    };
    }
  );

  const usableFlows = flows.filter((item) => item?.intraday?.series?.length);
  if (!usableFlows.length) {
    throw new Error("Sina live fallback returned no intraday sector flow");
  }

  const timeline = usableFlows[0]?.intraday?.series?.map((point) => point.time) || [];
  const tradeDate =
    usableFlows.find((item) => item.intraday.tradeDate)?.intraday.tradeDate ||
    getCurrentDateInChina();
  const updatedTime =
    usableFlows.find((item) => item.intraday.updatedTime)?.intraday.updatedTime || "";

  const payload = {
    category,
    categoryLabel: CATEGORY_MAP[category]?.label || CATEGORY_MAP.concept.label,
    mode,
    requestedLimit: limit,
    limit: usableFlows.length,
    fetchedAt: new Date().toISOString(),
    tradeDate,
    currentDate: getCurrentDateInChina(),
    updatedTime,
    timeline,
    fromSnapshot: false,
    partial: flowErrors.length > 0,
    partialFailures: flowErrors.map((item) => ({
      code: item.item?.code,
      name: item.item?.name,
      reason: item.reason
    })),
    fallbackReason: triggerError
      ? `${triggerError}；已切换新浪财经公开接口`
      : "已切换新浪财经公开接口",
    source: {
      id: "sina-live",
      provider: "新浪财经公开接口",
      boardFlowPage: "https://vip.stock.finance.sina.com.cn/moneyflow/",
      note: "新浪提供板块排行与板块分时资金，当前用于东方财富失败时的实时候补"
    },
    boards: usableFlows.map((item) => ({
      code: item.code,
      name: item.name,
      latest: item.latest,
      changePercent: item.changePercent,
      mainNet: item.mainNet,
      mainNetRatio: item.mainNetRatio,
      leaderName: item.leaderName,
      leaderCode: item.leaderCode,
      series: item.intraday.series,
      updatedTime: item.intraday.updatedTime
    }))
  };

  await writeSnapshot(payload);
  payload.availableDates = await listAvailableDates({
    category,
    mode
  });

  return payload;
}

async function buildUnavailableSectorPayload({ category, mode, limit, reason }) {
  return {
    category,
    categoryLabel: CATEGORY_MAP[category]?.label || CATEGORY_MAP.concept.label,
    mode,
    requestedLimit: limit,
    limit: 0,
    fetchedAt: new Date().toISOString(),
    tradeDate: getCurrentDateInChina(),
    currentDate: getCurrentDateInChina(),
    updatedTime: "",
    timeline: [],
    fromSnapshot: false,
    unavailable: true,
    fallbackReason: reason,
    availableDates: await listAvailableDates({ category, mode }),
    source: {
      id: "none",
      provider: "暂无可用实时源",
      note: "当前主源、候补源和本地快照都不可用"
    },
    boards: []
  };
}

async function buildSectorPayload({ category, mode, limit, date, refresh, policy = "taxonomy" }) {
  const currentDate = getCurrentDateInChina();
  const explicitlySelectedHistory = Boolean(date && date !== "today");
  const isToday = !date || date === "today" || (!explicitlySelectedHistory && date === currentDate);
  const allowedSnapshotSources = policy === "taxonomy" ? ["eastmoney-live"] : null;

  if (explicitlySelectedHistory && !refresh) {
    const payload = await readSnapshotBestMatch({
      date,
      category,
      mode,
      preferredLimit: limit,
      allowModeFallback: true,
      allowedSources: allowedSnapshotSources
    });
    payload.availableDates = await listAvailableDates({
      category,
      mode,
      allowedSources: allowedSnapshotSources
    });
    payload.currentDate = currentDate;
    payload.fromSnapshot = true;
    payload.requestedLimit = limit;
    payload.source = {
      ...(payload.source || {}),
      id: "local-snapshot"
    };
    if (payload.snapshotMode && payload.snapshotMode !== mode) {
      payload.fallbackReason = `当前模式历史快照缺失，改用 ${payload.snapshotMode} 快照`;
    }
    return payload;
  }

  try {
    return await buildLiveSectorPayload({ category, mode, limit, refresh });
  } catch (error) {
    const upstreamReason = error instanceof Error ? error.message : String(error);

    if (isToday && policy === "realtime") {
      try {
        return await buildSinaLiveSectorPayload({
          category,
          mode,
          limit,
          refresh,
          triggerError: upstreamReason
        });
      } catch (sinaError) {
        const sinaReason = sinaError instanceof Error ? sinaError.message : String(sinaError);
        const payload = await readSnapshotBestMatch({
          date: currentDate,
          category,
          mode,
          preferredLimit: limit,
          allowModeFallback: true,
          allowedSources: allowedSnapshotSources
        }).catch(async () =>
          readSnapshotBestMatch({
            category,
            mode,
            preferredLimit: limit,
            allowModeFallback: true,
            allowedSources: allowedSnapshotSources
          })
        ).catch(() => null);
        if (!payload) {
          return buildUnavailableSectorPayload({
            category,
            mode,
            limit,
            reason: `${upstreamReason}；新浪候补也失败：${sinaReason}`
          });
        }
        payload.availableDates = await listAvailableDates({
          category,
          mode,
          allowedSources: allowedSnapshotSources
        });
        payload.currentDate = currentDate;
        payload.fromSnapshot = true;
        payload.requestedLimit = limit;
        payload.source = {
          ...(payload.source || {}),
          id: "local-snapshot"
        };
        payload.fallbackReason =
          payload.snapshotMode && payload.snapshotMode !== mode
            ? `${upstreamReason}；新浪候补也失败：${sinaReason}；当前模式快照缺失，改用 ${payload.snapshotMode} 快照`
            : `${upstreamReason}；新浪候补也失败：${sinaReason}`;
        return payload;
      }
    }

    const payload = await readSnapshotBestMatch({
      date: currentDate,
      category,
      mode,
      preferredLimit: limit,
      allowModeFallback: true,
      allowedSources: allowedSnapshotSources
    }).catch(async () =>
      readSnapshotBestMatch({
        category,
        mode,
        preferredLimit: limit,
        allowModeFallback: true,
        allowedSources: allowedSnapshotSources
      })
    ).catch(() => null);
    if (!payload) {
      return buildUnavailableSectorPayload({
        category,
        mode,
        limit,
        reason: upstreamReason
      });
    }
    payload.availableDates = await listAvailableDates({
      category,
      mode,
      allowedSources: allowedSnapshotSources
    });
    payload.currentDate = currentDate;
    payload.fromSnapshot = true;
    payload.requestedLimit = limit;
    payload.source = {
      ...(payload.source || {}),
      id: "local-snapshot"
    };
    payload.fallbackReason =
      payload.snapshotMode && payload.snapshotMode !== mode
        ? `${upstreamReason}；当前模式快照缺失，改用 ${payload.snapshotMode} 快照`
        : upstreamReason;
    return payload;
  }
}

async function buildBoardConstituentPayload({ boardCode, boardName, category, refresh }) {
  if (!(category in THS_BOARD_CONFIG)) {
    return {
      boardCode,
      boardName,
      category,
      tradeDate: getCurrentDateInChina(),
      fetchedAt: new Date().toISOString(),
      fromSnapshot: false,
      source: {
        provider: "当前未接入稳定地域板块成分股源"
      },
      count: 0,
      positiveCount: 0,
      negativeCount: 0,
      constituents: []
    };
  }

  try {
    const result = await fetchThsBoardConstituents(category, boardName, {
      bypassCache: refresh
    });
    const sorted = [...result.constituents].sort(
      (left, right) =>
        (right.changePercent ?? Number.NEGATIVE_INFINITY) -
        (left.changePercent ?? Number.NEGATIVE_INFINITY)
    );
    const payload = {
      boardCode,
      boardName: result.boardName || boardName,
      category,
      tradeDate: getCurrentDateInChina(),
      fetchedAt: new Date().toISOString(),
      fromSnapshot: false,
      source: {
        provider: "同花顺板块成分股页面",
        url:
          category === "concept"
            ? `https://q.10jqka.com.cn/gn/detail/code/${result.thsCode}/`
            : `https://q.10jqka.com.cn/thshy/detail/code/${result.thsCode}/`,
        note: "当前展示现价、涨跌幅、换手、成交额和流通市值"
      },
      sortLabel: "按涨跌幅排序",
      count: sorted.length,
      positiveCount: sorted.filter((item) => (item.changePercent ?? 0) > 0).length,
      negativeCount: sorted.filter((item) => (item.changePercent ?? 0) < 0).length,
      constituents: sorted
    };
    await writeConstituentSnapshot(payload);
    return payload;
  } catch (error) {
    const payload = await readLatestConstituentSnapshot({ category, boardCode }).catch(
      () => null
    );

    if (payload) {
      payload.fromSnapshot = true;
      payload.fallbackReason = error instanceof Error ? error.message : String(error);
      payload.fetchedAt = new Date().toISOString();
      return payload;
    }

    throw error;
  }
}

async function buildBoardConstituentPayloadSafe({
  boardCode,
  boardName,
  category,
  refresh
}) {
  if (!(category in THS_BOARD_CONFIG)) {
    return {
      boardCode,
      boardName,
      category,
      tradeDate: getCurrentDateInChina(),
      fetchedAt: new Date().toISOString(),
      fromSnapshot: false,
      source: {
        provider: "当前还没有接入稳定的地域板块成分股来源"
      },
      count: 0,
      positiveCount: 0,
      negativeCount: 0,
      constituents: []
    };
  }

  try {
    const result = await fetchThsBoardConstituents(category, boardName, {
      bypassCache: refresh
    });
    const sorted = [...result.constituents].sort(
      (left, right) =>
        (right.changePercent ?? Number.NEGATIVE_INFINITY) -
        (left.changePercent ?? Number.NEGATIVE_INFINITY)
    );

    const payload = {
      boardCode,
      boardName: result.boardName || boardName,
      category,
      tradeDate: getCurrentDateInChina(),
      fetchedAt: new Date().toISOString(),
      fromSnapshot: false,
      source: {
        provider: "同花顺板块详情页",
        url:
          category === "concept"
            ? `https://q.10jqka.com.cn/gn/detail/code/${result.thsCode}/`
            : `https://q.10jqka.com.cn/thshy/detail/code/${result.thsCode}/`,
        note: result.resumed
          ? `已从第 ${result.resumedFromPage} 页续拉，当前展示现价、涨跌幅、换手、成交额和流通市值`
          : "当前展示现价、涨跌幅、换手、成交额和流通市值"
      },
      sortLabel: "按涨跌幅排序",
      count: sorted.length,
      positiveCount: sorted.filter((item) => (item.changePercent ?? 0) > 0).length,
      negativeCount: sorted.filter((item) => (item.changePercent ?? 0) < 0).length,
      constituents: sorted
    };

    await writeConstituentSnapshot(payload);
    return payload;
  } catch (error) {
    const snapshot = await readLatestConstituentSnapshot({ category, boardCode }).catch(
      () => null
    );

    if (snapshot) {
      snapshot.fromSnapshot = true;
      snapshot.fallbackReason = error instanceof Error ? error.message : String(error);
      snapshot.fetchedAt = new Date().toISOString();
      return snapshot;
    }

    const partialCheckpoint = error?.partialCheckpoint;
    if (partialCheckpoint?.rows?.length) {
      const sorted = [...partialCheckpoint.rows].sort(
        (left, right) =>
          (right.changePercent ?? Number.NEGATIVE_INFINITY) -
          (left.changePercent ?? Number.NEGATIVE_INFINITY)
      );

      return {
        boardCode,
        boardName: partialCheckpoint.boardName || boardName,
        category,
        tradeDate: getCurrentDateInChina(),
        fetchedAt: new Date().toISOString(),
        fromSnapshot: false,
        partial: true,
        resumeState: {
          lastSuccessfulPage: partialCheckpoint.lastSuccessfulPage,
          nextPage: partialCheckpoint.nextPage,
          totalPages: partialCheckpoint.totalPages
        },
        source: {
          provider: "同花顺板块详情页",
          note: `上游中断，已保存到第 ${partialCheckpoint.lastSuccessfulPage}/${partialCheckpoint.totalPages} 页，下次会从第 ${partialCheckpoint.nextPage} 页继续`
        },
        sortLabel: "按涨跌幅排序",
        count: sorted.length,
        positiveCount: sorted.filter((item) => (item.changePercent ?? 0) > 0).length,
        negativeCount: sorted.filter((item) => (item.changePercent ?? 0) < 0).length,
        constituents: sorted,
        fallbackReason:
          error?.cause instanceof Error ? error.cause.message : error.message
      };
    }

    throw error;
  }
}

function sanitizeCategory(value) {
  if (value === "industry" || value === "region" || value === "concept") {
    return value;
  }
  return "concept";
}

function sanitizeMode(value) {
  if (value === "inflow" || value === "outflow" || value === "balanced") {
    return value;
  }
  return "balanced";
}

function sanitizePolicy(value) {
  if (value === "realtime" || value === "taxonomy") {
    return value;
  }
  return "taxonomy";
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/sector-flows") {
      const category = sanitizeCategory(url.searchParams.get("category"));
      const mode = sanitizeMode(url.searchParams.get("mode"));
      const policy = sanitizePolicy(url.searchParams.get("policy"));
      const limit = Number(url.searchParams.get("limit") || "12");
      const date = url.searchParams.get("date");
      const refresh = url.searchParams.get("refresh") === "1";
      const payload = await buildSectorPayload({ category, mode, limit, date, refresh, policy });
      return json(res, 200, payload);
    }

    if (url.pathname === "/api/catalog") {
      const category = sanitizeCategory(url.searchParams.get("category"));
      const boards = await fetchBoardRanking(category);
      return json(res, 200, {
        category,
        categoryLabel: CATEGORY_MAP[category].label,
        boards: boards.map((item) => ({
          code: item.code,
          name: item.name,
          mainNet: item.mainNet,
          changePercent: item.changePercent
        }))
      });
    }

    if (url.pathname === "/api/source-strategy") {
      const category = sanitizeCategory(url.searchParams.get("category"));
      const mode = sanitizeMode(url.searchParams.get("mode"));
      const policy = sanitizePolicy(url.searchParams.get("policy"));
      const limit = Number(url.searchParams.get("limit") || "12");
      const usingSnapshot = url.searchParams.get("usingSnapshot") === "1";
      const activeSource = (url.searchParams.get("activeSource") || "eastmoney-live").trim();
      const payload = await buildSourceStrategyPayloadV2({
        category,
        mode,
        limit,
        policy,
        usingSnapshot,
        activeSource
      });
      if (policy === "taxonomy") {
        const sinaSource = payload.sources.find((item) => item.id === "sina-live");
        if (sinaSource) {
          sinaSource.status = "disabled";
          sinaSource.note = "你当前选择了东财体系优先，新浪候补被关闭，避免板块划分口径漂移。";
        }
        payload.recommendation =
          activeSource === "local-snapshot"
            ? "当前是东财体系优先模式：实时失败后只回退到同体系历史快照，不切新浪，方便学习同一套板块口径。"
            : "当前是东财体系优先模式：优先保证板块划分口径一致，更适合复盘和学习。";
      }
      return json(res, 200, payload);
    }

    if (url.pathname === "/api/network-health") {
      return json(res, 200, {
        nodes: getTransportDiagnostics(),
        upstreamCount: Object.keys(UPSTREAMS).length,
        circuitBreaker: CIRCUIT_BREAKER_CONFIG
      });
    }

    if (url.pathname === "/api/tdx/health") {
      const [quant, localCache] = await Promise.all([
        callTdxBridge("health"),
        getTdxLocalFileStatus()
      ]);
      return json(res, 200, {
        ok: quant.ok || localCache.available,
        quant,
        localCache,
        mode: quant.ok ? "tdxquant" : localCache.available ? "local-cache" : "unavailable"
      });
    }

    if (url.pathname === "/api/tdx/local-sectors") {
      const category = url.searchParams.get("category") === "industry" ? "industry" : "concept";
      const [sectors, status] = await Promise.all([
        getTdxLocalSectors(category),
        getTdxLocalFileStatus()
      ]);
      return json(res, 200, {
        ok: true,
        source: "tdx-local-cache",
        category,
        updatedAt: status.latestUpdatedAt,
        count: sectors.length,
        sectors: sectors.map((sector) => ({
          code: sector.code,
          name: sector.name,
          stockCount: sector.stocks.length
        }))
      });
    }

    if (url.pathname === "/api/tdx/local-sector-constituents") {
      const category = url.searchParams.get("category") === "industry" ? "industry" : "concept";
      const sectorQuery = (url.searchParams.get("sector") || "").trim();
      if (!sectorQuery || sectorQuery.length > 80) {
        return json(res, 400, { error: "bad_request", message: "Invalid sector" });
      }
      const [sectors, status] = await Promise.all([
        getTdxLocalSectors(category),
        getTdxLocalFileStatus()
      ]);
      const normalizedQuery = normalizeLookupName(sectorQuery);
      const sector = sectors.find(
        (item) =>
          item.code === sectorQuery || normalizeLookupName(item.name) === normalizedQuery
      );
      if (!sector) {
        return json(res, 404, { error: "not_found", message: "TDX local sector not found" });
      }
      return json(res, 200, {
        ok: true,
        source: "tdx-local-cache",
        category,
        updatedAt: status.latestUpdatedAt,
        sector: {
          code: sector.code,
          name: sector.name
        },
        count: sector.stocks.length,
        stocks: sector.stocks
      });
    }

    if (url.pathname === "/api/tdx/sectors") {
      const payload = await callTdxBridge("sectors");
      return json(res, payload.ok ? 200 : 503, payload);
    }

    if (url.pathname === "/api/tdx/sector-constituents") {
      const sector = (url.searchParams.get("sector") || "").trim();
      if (!sector || sector.length > 80) {
        return json(res, 400, { error: "bad_request", message: "Invalid sector" });
      }
      const payload = await callTdxBridge("constituents", { sector });
      return json(res, payload.ok ? 200 : 503, payload);
    }

    if (url.pathname === "/api/tdx/market-snapshot") {
      const codes = (url.searchParams.get("codes") || "")
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter((item) => /^\d{6}\.(SH|SZ|BJ)$/i.test(item))
        .slice(0, 200);
      if (!codes.length) {
        return json(res, 400, { error: "bad_request", message: "No valid codes" });
      }
      const payload = await callTdxBridge("market_snapshot", { codes });
      return json(res, payload.ok ? 200 : 503, payload);
    }

    if (url.pathname === "/api/board-constituents") {
      const boardCode = (url.searchParams.get("boardCode") || "").trim().toUpperCase();
      const boardName = (url.searchParams.get("boardName") || "").trim();
      const category = sanitizeCategory(url.searchParams.get("category"));
      const refresh = url.searchParams.get("refresh") === "1";

      if (!/^[A-Z0-9_.-]{2,40}$/i.test(boardCode)) {
        return json(res, 400, {
          error: "bad_request",
          message: "Invalid boardCode"
        });
      }

      const payload = await buildBoardConstituentPayloadSafe({
        boardCode,
        boardName,
        category,
        refresh
      });
      return json(res, 200, payload);
    }

    const targetPath =
      url.pathname === "/"
        ? path.join(publicDir, "index.html")
        : path.join(publicDir, url.pathname);
    const resolvedPath = path.resolve(targetPath);

    if (!resolvedPath.startsWith(publicDir) || !existsSync(resolvedPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    sendFile(res, resolvedPath);
  } catch (error) {
    json(res, 500, {
      error: "server_error",
      message:
        error instanceof Error
          ? error.stack || error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error)
    });
  }
});

server.listen(PORT, () => {
  console.log(`A-share sector flow app is running at http://localhost:${PORT}`);
});
