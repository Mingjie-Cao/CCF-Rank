import {
  matchCandidates,
  normalizeDOI,
  normalizeTitle,
  normalizeOpenAlexID,
  type Candidate,
  type Identity,
  type Lookup,
  type Provider,
} from "./core.js";

export interface HTTPResponse {
  status: number;
  data: unknown;
  retryAfter?: string;
}

type FetchJSON = (
  url: string,
  headers: Record<string, string>,
) => Promise<HTTPResponse>;

/** One limiter covers OpenAlex DOI lookup, title search and retries. */
export class CitationHTTP {
  private lastStart = -Infinity;
  private cooldown = new Map<string, number>();
  private credentials = new Map<string, string>();

  constructor(
    private fetchJSON: FetchJSON,
    private now: () => number,
    private sleep: (ms: number) => Promise<void>,
    private alive: () => boolean,
  ) {}

  async get(
    source: string,
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown | null> {
    if (!this.alive()) throw new Error("查询已停止");
    // A newly entered key has its own budget/authentication state. Do not let
    // an anonymous or old-key failure prevent a manual query with the new key.
    const credential = headers.Authorization || "";
    if (this.credentials.get(source) !== credential) {
      this.credentials.set(source, credential);
      this.cooldown.delete(source);
    }
    if (this.now() < (this.cooldown.get(source) || 0))
      throw new Error(`${source} 暂时不可用，请稍后刷新`);
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.sleep(Math.max(0, this.lastStart + 1100 - this.now()));
      if (!this.alive()) throw new Error("查询已停止");
      this.lastStart = this.now();
      let response: HTTPResponse;
      try {
        response = await this.fetchJSON(url, headers);
      } catch {
        if (attempt === 0) {
          await this.sleep(1100);
          continue;
        }
        this.cooldown.set(source, this.now() + 15_000);
        throw new Error(`${source} 网络错误或响应无效`);
      }
      if (response.status === 404) return null;
      if (response.status === 200) return response.data;
      if (response.status === 429) {
        const seconds = Number(response.retryAfter);
        const date = Date.parse(response.retryAfter || "");
        const delay = Math.max(
          1100,
          Number.isFinite(seconds) && response.retryAfter
            ? seconds * 1000
            : Number.isFinite(date)
              ? date - this.now()
              : 5000,
        );
        this.cooldown.set(source, this.now() + delay);
        if (attempt === 0 && delay <= 30_000) {
          await this.sleep(delay);
          continue;
        }
        throw new Error(`${source} 请求限流，请稍后刷新`);
      }
      if (response.status >= 500 && attempt === 0) {
        await this.sleep(1100);
        continue;
      }
      this.cooldown.set(
        source,
        this.now() + (response.status >= 500 ? 15_000 : 15 * 60_000),
      );
      throw new Error(
        `${source} HTTP ${response.status}${[401, 403].includes(response.status) ? "，请检查 API Key" : ""}`,
      );
    }
    throw new Error(`${source} 查询失败`);
  }
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("数据源响应格式无效");
  return value as Record<string, any>;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("数据源未返回有效被引次数");
  return value;
}

function openAlexCandidate(value: unknown): Candidate {
  const w = object(value);
  if (
    typeof w.id !== "string" ||
    !/^https:\/\/openalex\.org\/W\d+$/.test(w.id) ||
    typeof w.display_name !== "string"
  )
    throw new Error("OpenAlex 响应格式无效");
  return {
    id: w.id,
    doi: typeof w.doi === "string" ? normalizeDOI(w.doi) : undefined,
    title: w.display_name,
    year:
      typeof w.publication_year === "number" ? w.publication_year : undefined,
    authors: Array.isArray(w.authorships)
      ? w.authorships
          .map((a: any) => a?.author?.display_name)
          .filter((a: unknown) => typeof a === "string")
      : [],
    count: count(w.cited_by_count),
    url: w.id,
    venue:
      w.primary_location?.raw_source_name ||
      w.primary_location?.source?.display_name ||
      undefined,
  };
}

export class OpenAlexProvider implements Provider {
  constructor(
    private http: CitationHTTP,
    private settings: () => {
      openAlexKey: string;
    },
  ) {}

  async lookup(identity: Identity, boundPaperID?: string): Promise<Lookup> {
    const source = "openalex";
    const settings = this.settings();
    const base = "https://api.openalex.org/works";
    const fields =
      "select=id,doi,display_name,publication_year,cited_by_count,authorships,primary_location";
    const headers: Record<string, string> = {};
    if (settings.openAlexKey)
      headers.Authorization = `Bearer ${settings.openAlexKey}`;
    const decode = openAlexCandidate;
    const select = (candidates: Candidate[]): Lookup => {
      const match = matchCandidates(identity, candidates);
      return {
        status: match.status,
        detail: match.detail,
        candidates: match.candidates,
        result: match.candidate
          ? {
              count: match.candidate.count,
              source,
              paperID: match.candidate.id,
              url: match.candidate.url,
              matchedBy: match.matchedBy!,
            }
          : undefined,
      };
    };
    if (boundPaperID) {
      const id = normalizeOpenAlexID(boundPaperID);
      if (!id) throw new Error("已确认的 OpenAlex 标识无效");
      const data = await this.http.get(
        source,
        `${base}/${id.split("/").pop()}?${fields}`,
        headers,
      );
      if (!data)
        return {
          status: "not-found",
          detail: "已确认的 OpenAlex 记录不可用，请重新确认论文",
          candidates: [],
        };
      const candidate = decode(data);
      return {
        status: "ok",
        detail: "按人工确认的 OpenAlex 记录更新",
        result: {
          count: candidate.count,
          source,
          paperID: candidate.id,
          url: candidate.url,
          matchedBy: "confirmed",
        },
        candidates: [{ ...candidate, reasons: ["已人工确认的论文"] }],
      };
    }
    if (identity.doi) {
      const id = `https://doi.org/${identity.doi}`;
      const data = await this.http.get(
        source,
        `${base}/${encodeURIComponent(id)}?${fields}`,
        headers,
      );
      if (data) {
        const result = select([decode(data)]);
        if (result.status === "ok") return result;
      }
    }
    const title = normalizeTitle(identity.title);
    if (!title)
      return {
        status: "not-found",
        detail: "条目没有可查询的 DOI 或标题",
        candidates: [],
      };
    let result: Lookup = {
      status: "not-found",
      candidates: [],
      detail: "未检索到标题相符的候选记录",
    };
    // Search titles, not papers that merely cite or discuss the target paper.
    // Use a full phrase first; only widen when it yields no plausible candidate.
    for (const query of [`"${title}"`, title]) {
      const data = await this.http.get(
        source,
        `${base}?search.title=${encodeURIComponent(query)}&per_page=50&${fields}`,
        headers,
      );
      if (!data) continue;
      const response = object(data);
      if (!Array.isArray(response.results))
        throw new Error(`${source} 搜索响应格式无效`);
      result = select(response.results.map(decode));
      const total = response.meta?.count;
      if (
        result.status === "ok" &&
        result.result?.matchedBy === "title" &&
        typeof total === "number" &&
        total > response.results.length
      ) {
        result = {
          status: "ambiguous",
          candidates: result.candidates,
          detail: "搜索结果尚未取全，无法确认唯一性，请人工确认论文",
        };
      }
      if (result.status !== "not-found") return result;
    }
    return result;
  }
}
