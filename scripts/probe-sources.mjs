import { readFile, writeFile } from "node:fs/promises";

/**
 * 探测 TVBox/影视仓配置里究竟有多少「可用采集接口」。
 *
 * 为什么需要这个脚本：`check-availability.mjs` 只判断资源主页的 HTTP 状态。
 * 对 `tvbox_config` 分类来说这个信号几乎不成立——配置文件的托管地址常年 200，
 * 但配置本体可能返回图片、HTML、纯文本，也可能 JSON 合法却全是需要 TVBox
 * 引擎才能运行的 Spider 条目。于是首页会显示「🟢 可访问」，而使用者导入后
 * 一个源都搜不出来。
 *
 * 这里补上另一个维度：抓配置 → 抽出可直连的 Apple CMS 采集接口 →
 * 逐个探活 → 记录「这条配置里有几个接口现在真的能取到内容」。
 * 结果写入 `reports/sources.json`，并回填 README 里 TVBox 配置表格的
 * 「可用源」列（标记缺失时静默跳过，不阻断其余流程）。
 *
 * 判据用「最新入库」（`?ac=videolist&pg=1`）而不是关键词搜索：中文采集站对
 * 拉丁关键词普遍零命中，用 `wd=test` 会把活站误判成死站。
 *
 * 与 `check-availability.mjs` 一样，结果只代表 GitHub Actions 节点当时的网络
 * 情况，不替代人工验证，也不代表内容规模或画质。
 */

const root = new URL("../", import.meta.url);
const resourcesPath = new URL("resources/resources.json", root);
const sourcesPath = new URL("reports/sources.json", root);
const readmePath = new URL("README.md", root);

const configTimeoutMs = Number(process.env.PROBE_CONFIG_TIMEOUT_MS ?? 10000);
const sourceTimeoutMs = Number(process.env.PROBE_SOURCE_TIMEOUT_MS ?? 8000);
const configConcurrency = Number(process.env.PROBE_CONFIG_CONCURRENCY ?? 4);
const sourceConcurrency = Number(process.env.PROBE_SOURCE_CONCURRENCY ?? 8);
const maxAttempts = Number(process.env.PROBE_MAX_ATTEMPTS ?? 2);
const multiRepoChildren = Number(process.env.PROBE_MULTI_REPO_CHILDREN ?? 8);
const totalBudgetMs = Number(process.env.PROBE_TOTAL_BUDGET_MS ?? 180000);
const timeZone = process.env.PROBE_TIME_ZONE ?? "Asia/Shanghai";
const userAgent =
  "awesome-zhuiju-free-prober/1.0 (+https://github.com/laoma528/awesome-zhuiju-free)";

/** 多仓配置最多向下展开几层，避免个别仓库互相引用导致无限递归 */
const maxDepth = 2;
/** 报告里保留的接口失败样例条数，够定位问题即可 */
const failSampleLimit = 5;
/** 只重试「连接抖动 / 超时」；HTTP 状态码错误与空入库是确定性失败 */
const retryablePattern = /^(连接失败|超时)$/;

/**
 * Apple CMS 接口归一化：上游配置里的地址普遍带两类杂质，直接收录就是死链。
 * - 查询串：`.../provide/vod/?ac=list`，TVBox 客户端自己拼参数，本项目也自己拼；
 * - TVBox 专用后缀：`.../provide/vod/from/hym3u8`、`/at/m3u8/`，那是给播放器
 *   拼流用的格式提示，标准 `?ac=` 接口不认。
 * 因此一律截断到 `/provide/vod` 为止，丢弃其后的一切。非该形态返回 null，
 * 顺带把 XML 接口（`/at/xml`）和需要 TVBox 引擎的 Spider 地址排除在外。
 */
function canonicalCmsBase(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const matched = parsed.pathname.match(/^(.*\/provide\/vod)(?!\/at\/xml)(?:\/.*)?$/i);
  if (!matched) {
    return null;
  }
  return `${parsed.origin}${matched[1]}`;
}

/** 去重键：主机 + 路径。忽略协议与查询串差异（http/https、尾斜杠视为同一条） */
function cmsDedupeKey(base) {
  try {
    const parsed = new URL(base);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return base.toLowerCase();
  }
}

/** 把 undici 的英文错误翻成人话，报告里给非技术读者看 */
function describeError(error) {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return "超时";
  }
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up/i.test(message)) {
    return "连接失败";
  }
  return message || "请求失败";
}

/**
 * README 标记回填。与 `check-availability.mjs` 的 `replaceMarker` 不同：
 * 找不到标记时**不抛错**，原样返回。因为「可用源」列是后加的，
 * 这一版脚本必须能在还没有该列的 README 上安全跑完全程。
 */
function patchMarker(readme, type, resourceId, value) {
  const start = `<!-- ${type}:${resourceId} -->`;
  const end = `<!-- /${type}:${resourceId} -->`;
  const pattern = new RegExp(
    `${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "s"
  );
  if (!pattern.test(readme)) {
    return readme;
  }
  return readme.replace(pattern, `${start}${value}${end}`);
}

/**
 * 「可用源」列的展示文案。
 * 刻意与 `sync-readme.mjs` 里的同名函数保持一致（那边负责首次渲染，
 * 这边负责每日回填）——仓库现状也是把同一份状态文案写在两个脚本里。
 */
function displayPlayable(result) {
  const status = result?.status ?? "unknown";
  if (status === "usable" && result.passed > 0) {
    return `🟢&#8288;${result.passed}&#8288;个`;
  }
  return {
    dead: "🔴&#8288;全&#8288;不&#8288;可&#8288;用",
    no_cms: "⚪&#8288;无&#8288;接&#8288;口",
    unreadable: "🔴&#8288;读&#8288;不&#8288;到",
    unknown: "⚪&#8288;未&#8288;检&#8288;测"
  }[status] ?? "⚪&#8288;未&#8288;检&#8288;测";
}

/** 剥离字符串外部的行注释与块注释（部分共享配置带注释，标准 JSON.parse 会失败） */
function stripComments(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      const code = char.charCodeAt(0);
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += char;
      // 转义符连同其后一位原样保留，避免 \" 被误判成字符串结束
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    out += char;
  }

  return out;
}

/** 剥离尾随逗号（`{"a":1,}` / `[1,2,]`），需在注释剥离之后进行 */
function stripTrailingCommas(text) {
  let out = "";
  let inString = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let probe = index + 1;
      while (probe < text.length && /\s/.test(text[probe])) {
        probe += 1;
      }
      if (text[probe] === "}" || text[probe] === "]") {
        continue;
      }
    }
    out += char;
  }

  return out;
}

/** 宽容 JSON 解析：TVBox 生态里带注释与尾随逗号的配置相当常见 */
function parseJsonTolerant(text) {
  return JSON.parse(stripTrailingCommas(stripComments(text.replace(/^\uFEFF/, ""))));
}

function parseConfig(text) {
  let json;
  try {
    json = parseJsonTolerant(text);
  } catch {
    throw new Error("不是合法的 JSON");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("配置顶层不是一个对象");
  }
  return json;
}

/** 抓配置文本，每次尝试各自持有独立超时预算 */
async function fetchConfigText(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(configTimeoutMs),
        headers: {
          "user-agent": userAgent,
          accept: "application/json,text/plain,*/*"
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      // 少数「配置地址」实际指向一张图片（TVBox 支持把配置藏在图里）
      if (/^image\//i.test(contentType)) {
        throw new Error(`返回图片（${contentType.split(";")[0]}）`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : "";
      // 4xx 是确定性失败，重试没有意义
      if (/^HTTP 4\d\d$/.test(message)) {
        break;
      }
    }
  }

  throw lastError ?? new Error("请求失败");
}

/** 从 TVBox 配置里抽出可直连的 Apple CMS 采集接口（已归一化、去重） */
function collectCmsSites(json) {
  const rawSites = Array.isArray(json.sites) ? json.sites : [];
  const seen = new Set();
  const sites = [];
  let candidates = 0;

  for (const raw of rawSites) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const api = typeof raw.api === "string" ? raw.api.trim() : "";
    if (!api) {
      continue;
    }
    // Spider（csp_ 前缀或 jar/js/py 资源）需要 TVBox 引擎才能运行
    if (/^csp_|\.(?:jar|js|py)(?:[?#].*)?$/i.test(api)) {
      continue;
    }
    // 站点自身声明不可搜索时，采集接口对本项目没有意义
    if (raw.searchable === 0 || raw.searchable === "0") {
      continue;
    }
    const base = canonicalCmsBase(api);
    if (!base) {
      continue;
    }
    candidates += 1;
    const key = cmsDedupeKey(base);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    sites.push({ name: name || new URL(base).hostname, url: base });
  }

  return { sites, candidates };
}

/** 多仓配置：顶层没有 sites，只有一份 `urls` 子配置清单 */
function collectChildConfigs(json) {
  const rawUrls = Array.isArray(json.urls) ? json.urls : [];
  const children = [];

  for (const raw of rawUrls) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    children.push({ url });
  }

  return children.slice(0, multiRepoChildren);
}

/** 递归解析配置本体；多仓配置向下展开一层拿到真正的 sites */
async function inspectConfig(url, depth) {
  const json = parseConfig(await fetchConfigText(url));
  const hasSites = Array.isArray(json.sites);
  const children = collectChildConfigs(json);

  if (!hasSites && children.length === 0) {
    throw new Error("不是 TVBOX 配置（既没有 sites 也没有 urls）");
  }

  const { sites, candidates } = collectCmsSites(json);
  if (sites.length > 0 || children.length === 0 || depth >= maxDepth) {
    return { format: hasSites ? "tvbox" : "multi_repo", sites, candidates };
  }

  const nested = await mapConcurrent(children, configConcurrency, async (child) => {
    try {
      return await inspectConfig(child.url, depth + 1);
    } catch {
      // 单个子配置失败只丢自己，其余照常汇总
      return null;
    }
  });

  const merged = [];
  const seen = new Set();
  for (const item of nested) {
    for (const site of item?.sites ?? []) {
      const key = cmsDedupeKey(site.url);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(site);
    }
  }

  return {
    format: "multi_repo",
    sites: merged,
    candidates: candidates + nested.reduce((sum, item) => sum + (item?.candidates ?? 0), 0)
  };
}

/**
 * 单源探活：`?ac=videolist&pg=1` 是「最新入库」，不依赖关键词，
 * 只要有内容就返回，判据比 `wd=test` 搜索稳得多。
 */
async function probeSource(base) {
  const url = `${base}?ac=videolist&pg=1`;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(sourceTimeoutMs),
      headers: {
        "user-agent": userAgent,
        accept: "application/json,text/plain,*/*"
      }
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const text = await response.text();
    let count = 0;
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.list) ? data.list : data?.data?.list;
      count = Array.isArray(list) ? list.length : 0;
    } catch {
      return { ok: false, reason: "返回内容不是 JSON" };
    }
    return count > 0 ? { ok: true, count } : { ok: false, reason: "无入库内容" };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

async function mapConcurrent(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function probeResource(resource, deadline) {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const base = {
    resource_id: resource.id,
    url: resource.url,
    status: "unreadable",
    config_format: null,
    cms_total: 0,
    cms_unique: 0,
    passed: 0,
    response_ms: 0,
    checked_at: checkedAt,
    error: null,
    failed_samples: []
  };

  let format = null;
  let sites = [];
  let candidates = 0;
  try {
    const inspected = await inspectConfig(resource.url, 0);
    format = inspected.format;
    sites = inspected.sites;
    candidates = inspected.candidates;
  } catch (error) {
    return {
      ...base,
      response_ms: Date.now() - startedAt,
      error: describeError(error)
    };
  }

  if (sites.length === 0) {
    return {
      ...base,
      status: "no_cms",
      config_format: format,
      cms_total: candidates,
      response_ms: Date.now() - startedAt
    };
  }

  const verdicts = await mapConcurrent(sites, sourceConcurrency, async (site) => {
    if (Date.now() > deadline) {
      return { ok: false, reason: "超出本次时间预算" };
    }
    return probeSource(site.url);
  });

  // 第二轮只补「连接层失败 / 超时」的。同一份配置连跑几轮，总有一两个接口
  // 被偶发抖动刷掉；而 HTTP 状态码错误、空入库重试一次还是同样结果。
  // 第二轮跑在首轮之后，因此不拖慢首轮。
  const retryable = verdicts
    .map((verdict, index) => (!verdict.ok && retryablePattern.test(verdict.reason) ? index : -1))
    .filter((index) => index >= 0 && Date.now() < deadline);

  if (retryable.length > 0) {
    const second = await mapConcurrent(retryable, sourceConcurrency, async (index) => {
      if (Date.now() > deadline) {
        return { ok: false, reason: "超出本次时间预算" };
      }
      return probeSource(sites[index].url);
    });
    retryable.forEach((index, position) => {
      if (second[position].ok) {
        verdicts[index] = second[position];
      }
    });
  }

  const passed = verdicts.filter((verdict) => verdict.ok).length;
  const failedSamples = [];
  verdicts.forEach((verdict, index) => {
    if (!verdict.ok && failedSamples.length < failSampleLimit) {
      failedSamples.push({
        name: sites[index].name,
        url: sites[index].url,
        reason: verdict.reason
      });
    }
  });

  return {
    ...base,
    status: passed > 0 ? "usable" : "dead",
    config_format: format,
    cms_total: candidates,
    cms_unique: sites.length,
    passed,
    response_ms: Date.now() - startedAt,
    failed_samples: failedSamples
  };
}

const resourcesData = JSON.parse(await readFile(resourcesPath, "utf8"));
const targets = resourcesData.resources.filter(
  (resource) => resource.featured && resource.category === "tvbox_config"
);
const generatedAt = new Date().toISOString();
const deadline = Date.now() + totalBudgetMs;

console.log(`Probing ${targets.length} TVBox config resource(s)...`);
const results = await mapConcurrent(targets, configConcurrency, (resource) =>
  probeResource(resource, deadline)
);

await writeFile(
  sourcesPath,
  `${JSON.stringify(
    {
      version: 1,
      generated_at: generatedAt,
      prober: {
        environment: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
        config_timeout_ms: configTimeoutMs,
        source_timeout_ms: sourceTimeoutMs,
        config_concurrency: configConcurrency,
        source_concurrency: sourceConcurrency,
        max_attempts: maxAttempts,
        multi_repo_children: multiRepoChildren,
        time_zone: timeZone
      },
      results
    },
    null,
    2
  )}\n`,
  "utf8"
);

let readme = await readFile(readmePath, "utf8");
for (const result of results) {
  readme = patchMarker(readme, "playable", result.resource_id, displayPlayable(result));
}
await writeFile(readmePath, readme, "utf8");

for (const result of results) {
  const label = displayPlayable(result).replaceAll(/&#\d+;/g, "");
  const detail =
    result.status === "usable"
      ? `${result.passed}/${result.cms_unique} 个采集接口可用（抽出 ${result.cms_total} 条）`
      : result.status === "dead"
        ? `${result.cms_unique} 个采集接口均不可用`
        : result.status === "no_cms"
          ? "配置可用，但没有可直连的 Apple CMS 采集接口"
          : (result.error ?? "配置无法读取");
  console.log(`${label} ${result.resource_id}: ${detail}`);
}

const usable = results.filter((result) => result.status === "usable");
const totalPassed = results.reduce((sum, result) => sum + result.passed, 0);
console.log(
  `Done: ${usable.length}/${results.length} config(s) yield at least one usable source, ${totalPassed} usable source(s) in total.`
);
