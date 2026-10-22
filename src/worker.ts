interface Env {
  ASSETS: Fetcher;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  ANALYSIS_PROMPT?: string;
  MAX_MAKLER_PAGES?: string;
  STALE_AFTER_DAYS?: string;
}

type Source = "Job" | "Makler";
interface Vacancy { source: Source; title: string; city: string; url: string; text: string; postedAt?: string; }

const JOB_HOME = "https://job.hi-tech.md/";
const MAKLER_ORIGIN = "https://makler.md";
const MAKLER_LIST = `${MAKLER_ORIGIN}/ru/an/user/search/id/1262205/page`;
const USER_AGENT = "VacancyAuditor/1.0 (+https://job.hi-tech.md/)";
const MAX_TEXT_PER_VACANCY = 5_000;
const DETAIL_CONCURRENCY = 5;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function decodeEntities(value: string): string {
  return value.replace(/&#x([0-9a-f]+);?/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&#(\d+);?/g, (_, x) => String.fromCodePoint(parseInt(x, 10))).replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;/gi, '"').replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&apos;|&#39;/gi, "'");
}

function cleanText(html: string): string {
  return decodeEntities(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ").replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|section|article)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/\s*\n\s*/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim());
}

function textMatch(html: string, expression: RegExp): string { const found = expression.exec(html); return found ? cleanText(found[1]) : ""; }
function absoluteUrl(path: string, origin: string): string { return new URL(path, origin).toString(); }

async function fetchHtml(url: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(url, { ...init, headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml", ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`Источник вернул HTTP ${response.status}: ${url}`);
  return response.text();
}

async function mapConcurrent<T, R>(items: T[], limit: number, action: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []; let cursor = 0;
  async function worker() { while (cursor < items.length) { const index = cursor++; results[index] = await action(items[index]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function pickJobCity(page: string): string {
  return textMatch(page, /icon-map-pin[\s\S]*?<\/i>\s*([^<]{2,80})<\/h[45]>/i) || textMatch(page, /<span[^>]*>\s*(Тирасполь|Бендеры|Рыбница|Днестровск|Дубоссары|Слободзея|Каменка)[^<]*<\/span>/i) || "Не указан";
}

async function collectJobVacancies(): Promise<Vacancy[]> {
  const listHtml = await fetchHtml(JOB_HOME);
  const urls = [...listHtml.matchAll(/href=["'](https:\/\/job\.hi-tech\.md\/job\/[^"'?#]+)["']/gi)].map((m) => m[1]).filter((url) => !url.endsWith("/apply"));
  return mapConcurrent([...new Set(urls)], DETAIL_CONCURRENCY, async (url) => {
    const page = await fetchHtml(url);
    return { source: "Job", title: textMatch(page, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || "Без названия", city: pickJobCity(page), url,
      text: (textMatch(page, /<main\b[^>]*>([\s\S]*?)<\/main>/i) || cleanText(page)).slice(0, MAX_TEXT_PER_VACANCY) };
  });
}

interface MaklerListItem { url: string; title: string; city: string; }
function parseMaklerList(html: string): MaklerListItem[] {
  const items: MaklerListItem[] = [];
  for (const article of html.matchAll(/<article\b[\s\S]*?<\/article>/gi)) {
    const block = article[0]; const href = /<a\s+href=["']([^"']+)["'][^>]*class=["'][^"']*ls-detail_anUrl[^"']*["']/i.exec(block)?.[1];
    if (href) items.push({ url: absoluteUrl(href, MAKLER_ORIGIN), title: textMatch(block, /ls-detail_antTitle[\s\S]*?<span>([\s\S]*?)<\/span>/i) || "Без названия", city: textMatch(block, /ls-jobMeta_chip--city[\s\S]*?>([\s\S]*?)<\/span>/i) || "Не указан" });
  }
  return items;
}

function getJobPosting(html: string): Record<string, unknown> | undefined {
  for (const script of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const data = JSON.parse(script[1]) as Record<string, unknown> | Record<string, unknown>[]; const posting = (Array.isArray(data) ? data : [data]).find((item) => item["@type"] === "JobPosting"); if (posting) return posting; } catch { /* Ignore malformed JSON-LD. */ }
  }
  return undefined;
}

async function collectMaklerVacancies(maxPages: number): Promise<Vacancy[]> {
  const items: MaklerListItem[] = []; let totalPages = 1;
  for (let page = 0; page < totalPages && page < maxPages; page += 1) {
    const html = await fetchHtml(`${MAKLER_LIST}/${page}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest", referer: "https://makler.md/ru/an/user/index/id/1262205?list=detail" }, body: "list=detail" });
    const total = Number(/id=["']totalFoundRows["'][^>]*value=["'](\d+)["']/i.exec(html)?.[1] || "0"); totalPages = Math.max(1, Math.ceil(total / 30)); items.push(...parseMaklerList(html));
  }
  const uniqueItems = [...new Map(items.map((item) => [item.url, item])).values()];
  return mapConcurrent(uniqueItems, DETAIL_CONCURRENCY, async (item) => {
    const page = await fetchHtml(item.url); const posting = getJobPosting(page); const address = posting?.jobLocation as { address?: { addressLocality?: string } } | undefined;
    const description = typeof posting?.description === "string" ? cleanText(posting.description) : "";
    return { source: "Makler", title: typeof posting?.title === "string" ? posting.title : textMatch(page, /id=["']anNameData["'][^>]*>([\s\S]*?)<\/strong>/i) || item.title, city: address?.address?.addressLocality || item.city, url: item.url, text: (description || cleanText(page)).slice(0, MAX_TEXT_PER_VACANCY), postedAt: typeof posting?.datePosted === "string" ? posting.datePosted : undefined };
  });
}

function normalise(value: string): string { return value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function buildMatchingHints(job: Vacancy[], makler: Vacancy[]) {
  const mKeys = new Set(makler.map((item) => `${normalise(item.title)}|${normalise(item.city)}`)); const jKeys = new Set(job.map((item) => `${normalise(item.title)}|${normalise(item.city)}`));
  return { exactPairs: job.filter((item) => mKeys.has(`${normalise(item.title)}|${normalise(item.city)}`)).map((item) => ({ title: item.title, city: item.city })), onlyJob: job.filter((item) => !mKeys.has(`${normalise(item.title)}|${normalise(item.city)}`)).map((item) => ({ title: item.title, city: item.city, url: item.url })), onlyMakler: makler.filter((item) => !jKeys.has(`${normalise(item.title)}|${normalise(item.city)}`)).map((item) => ({ title: item.title, city: item.city, url: item.url })) };
}

const defaultPrompt = "Ты — редактор вакансий и аудитор качества публикаций. Сравни данные Job и Makler. Проверь орфографию, пунктуацию и стиль; полноту обязательной информации (обязанности, требования, условия, график, оплата, город и контакты, если уместны); содержательные противоречия и неполное соответствие парных вакансий. Вакансии одной пары определяются прежде всего одинаковыми названием и городом. Отдельно перечисли объявления только на одном источнике и Makler-вакансии, размещённые более 12 дней назад. Не придумывай фактов: если данных не хватает, назови конкретно, чего нет.";
function promptEnvelope(customPrompt: string | undefined): string {
  return `${customPrompt?.trim() || defaultPrompt}\n\nВерни ТОЛЬКО корректный JSON без Markdown: {"overview":"краткий итог","items":[{"category":"одно из: Противоречие | Несоответствие | Неполные данные | Орфография и стиль | Только один сайт | Давность Makler","title":"название вакансии","city":"город","jobUrl":"ссылка или пустая строка","maklerUrl":"ссылка или пустая строка","findings":["конкретные замечания"],"recommendations":["что исправить"]}]}. Если нарушений нет, верни пустой items. Пиши по-русски. Ссылки сохраняй из входных данных.`;
}

function parseModelReport(content: string, counts: Record<string, number>) {
  const candidate = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return { ...(JSON.parse(candidate) as Record<string, unknown>), stats: counts }; } catch { return { overview: "DeepSeek вернул ответ в нестандартном формате. Ниже — исходный текст ответа.", items: [{ category: "Результат анализа", title: "Все вакансии", city: "", findings: [content], recommendations: [] }], stats: counts }; }
}

async function requestAnalysis(env: Env, job: Vacancy[], makler: Vacancy[]) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("Не задан секрет DEEPSEEK_API_KEY. Добавьте его в настройках Cloudflare Workers.");
  const matching = buildMatchingHints(job, makler); const input = { checkedAt: new Date().toISOString(), job, makler, matchingHints: matching, staleAfterDays: Math.max(1, Number(env.STALE_AFTER_DAYS || "12")) };
  const response = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: env.DEEPSEEK_MODEL || "deepseek-chat", temperature: 0.1, response_format: { type: "json_object" }, messages: [{ role: "system", content: promptEnvelope(env.ANALYSIS_PROMPT) }, { role: "user", content: JSON.stringify(input) }] }) });
  if (!response.ok) throw new Error(`DeepSeek вернул HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }; const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek не вернул текст анализа.");
  return parseModelReport(content, { job: job.length, makler: makler.length, onlyJobByExactKey: matching.onlyJob.length, onlyMaklerByExactKey: matching.onlyMakler.length });
}

async function runAudit(env: Env) { const maxPages = Math.max(1, Math.min(Number(env.MAX_MAKLER_PAGES || "10"), 30)); const [job, makler] = await Promise.all([collectJobVacancies(), collectMaklerVacancies(maxPages)]); return { report: await requestAnalysis(env, job, makler), checkedAt: new Date().toISOString() }; }

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/check") { if (request.method !== "POST") return json({ error: "Используйте POST." }, 405); try { return json(await runAudit(env)); } catch (error) { console.error(error); return json({ error: error instanceof Error ? error.message : "Неизвестная ошибка проверки." }, 502); } }
  return env.ASSETS.fetch(request);
} } satisfies ExportedHandler<Env>;
