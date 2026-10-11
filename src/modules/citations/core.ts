/** Citation logic independent of Zotero, so matching and cache policy are testable. */
export type Source = "openalex" | "manual";
export type Status = "ok" | "not-found" | "ambiguous" | "error";

export interface Identity {
  key: string;
  doi?: string;
  title: string;
  year?: number;
  author?: string;
}

export interface Candidate {
  id: string;
  doi?: string;
  title: string;
  year?: number;
  authors: string[];
  count: number;
  url: string;
  venue?: string;
}

export interface ReviewCandidate extends Candidate {
  reasons: string[];
}

export interface Result {
  count: number;
  source: Source;
  paperID: string;
  url: string;
  matchedBy: "doi" | "title" | "confirmed" | "manual";
  updatedAt: number;
}

export interface RecordEntry {
  identity: string;
  status: Status;
  checkedAt: number;
  retryAt: number;
  result?: Result;
  error?: string;
  detail?: string;
  candidates?: ReviewCandidate[];
  boundPaperID?: string;
}

export interface Lookup {
  status: Exclude<Status, "error">;
  result?: Omit<Result, "updatedAt">;
  detail?: string;
  candidates?: ReviewCandidate[];
}

export interface Provider {
  lookup(identity: Identity, boundPaperID?: string): Promise<Lookup>;
}

export const DAY = 86_400_000;

/** Fixed-width keys sort numerically even with Zotero's text column comparator. */
export function countSortKey(count: number): string {
  return String(count).padStart(16, "0");
}

export function normalizeDOI(input: string): string | undefined {
  let value = input
    .trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return /^10\.\d{4,9}\/\S+$/i.test(value) ? value.toLowerCase() : undefined;
}

export function normalizeTitle(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function fingerprint(identity: Identity): string {
  return JSON.stringify([
    identity.doi || "",
    normalizeTitle(identity.title),
    identity.year || null,
    normalizeTitle(identity.author || ""),
  ]);
}

export function normalizeOpenAlexID(input: string): string | undefined {
  if (typeof input !== "string") return undefined;
  const match = input
    .trim()
    .match(/^(?:https:\/\/openalex\.org\/(?:works\/)?)?(W\d+)\/?$/i);
  return match ? `https://openalex.org/${match[1].toUpperCase()}` : undefined;
}

function titleSimilarity(a: string, b: string): number {
  const left = new Set(a.split(" "));
  const right = new Set(b.split(" "));
  const overlap = [...left].filter((word) => right.has(word)).length;
  return (2 * overlap) / Math.max(1, left.size + right.size);
}

/** Never pick the highest-cited hit; reject ambiguous or conflicting metadata. */
export function matchCandidates(
  identity: Identity,
  candidates: Candidate[],
): {
  status: "ok" | "not-found" | "ambiguous";
  candidate?: Candidate;
  matchedBy?: "doi" | "title";
  candidates: ReviewCandidate[];
  detail: string;
} {
  const unique = [...new Map(candidates.map((c) => [c.id, c])).values()];
  const doiMatches = identity.doi
    ? unique.filter((c) => c.doi === identity.doi)
    : [];
  if (doiMatches.length === 1) {
    return {
      status: "ok",
      candidate: doiMatches[0],
      matchedBy: "doi",
      candidates: [{ ...doiMatches[0], reasons: [] }],
      detail: "DOI 精确匹配",
    };
  }
  if (doiMatches.length > 1)
    return {
      status: "ambiguous",
      detail: "同一 DOI 对应多个记录，请确认论文",
      candidates: doiMatches.map((c) => ({
        ...c,
        reasons: ["同一 DOI 对应多个记录"],
      })),
    };
  const title = normalizeTitle(identity.title);
  // Short/generic titles without a DOI are too weak to identify a work.
  if (title.replace(/\s/g, "").length < 12)
    return {
      status: "not-found",
      candidates: [],
      detail: "标题过短，无法可靠识别论文，请补充 DOI",
    };
  const reviewed = unique.flatMap((c) => {
    const candidateTitle = normalizeTitle(c.title);
    const exact = candidateTitle === title;
    if (!exact && titleSimilarity(title, candidateTitle) < 0.75) return [];
    const reasons: string[] = [];
    const doiConflict = Boolean(
      identity.doi && c.doi && c.doi !== identity.doi,
    );
    const yearConflict = Boolean(
      identity.year && c.year && c.year !== identity.year,
    );
    const authorMatches = Boolean(
      identity.author &&
      c.authors.some((a) =>
        ` ${normalizeTitle(a)} `.includes(
          ` ${normalizeTitle(identity.author!)} `,
        ),
      ),
    );
    const authorConflict = Boolean(
      identity.author && c.authors.length && !authorMatches,
    );
    if (!exact) reasons.push("标题存在差异");
    if (doiConflict) reasons.push("DOI 不一致，可能是不同版本或不同论文");
    if (yearConflict)
      reasons.push(`年份不一致（条目 ${identity.year}，候选 ${c.year}）`);
    if (authorConflict) reasons.push("作者不一致");
    if (identity.author && !c.authors.length)
      reasons.push("OpenAlex 作者信息缺失");
    if (identity.year && !c.year) reasons.push("OpenAlex 年份信息缺失");
    const corroborated = Boolean(
      (identity.year && c.year === identity.year) || authorMatches,
    );
    if (!corroborated) reasons.push("缺少可核对的年份或作者信息");
    return [
      {
        candidate: { ...c, reasons },
        auto:
          exact &&
          !doiConflict &&
          !yearConflict &&
          !authorConflict &&
          corroborated,
        exact,
      },
    ];
  });
  const matches = reviewed.filter((c) => c.auto);
  const reviewOptions = reviewed
    .sort((a, b) => Number(b.exact) - Number(a.exact))
    .slice(0, 10)
    .map((c) => c.candidate);
  if (matches.length === 1)
    return {
      status: "ok",
      candidate: matches[0].candidate,
      matchedBy: "title",
      candidates: reviewOptions,
      detail: ["标题及可用元数据一致", ...matches[0].candidate.reasons].join(
        "；",
      ),
    };
  return {
    status: reviewOptions.length ? "ambiguous" : "not-found",
    candidates: reviewOptions,
    detail:
      matches.length > 1
        ? "多个候选符合匹配条件，请确认论文"
        : reviewOptions.length
          ? "找到候选，但元数据不完整或存在差异，请确认论文"
          : "未检索到标题相符的候选记录",
  };
}

function validResult(value: unknown): value is Result {
  if (!value || typeof value !== "object") return false;
  const r = value as Result;
  return (
    Number.isSafeInteger(r.count) &&
    r.count >= 0 &&
    ["openalex", "manual"].includes(r.source) &&
    ["doi", "title", "confirmed", "manual"].includes(r.matchedBy) &&
    typeof r.paperID === "string" &&
    typeof r.url === "string" &&
    Number.isFinite(r.updatedAt) &&
    Number.isFinite(new Date(r.updatedAt).getTime()) &&
    r.updatedAt >= 0
  );
}

export function parseCache(raw: string): Map<string, RecordEntry> {
  const entries = new Map<string, RecordEntry>();
  try {
    const store = JSON.parse(raw);
    if (
      ![1, 2].includes(store.version) ||
      !store.items ||
      typeof store.items !== "object"
    )
      return entries;
    for (const [key, value] of Object.entries(store.items)) {
      const e = value as RecordEntry;
      if (
        !e ||
        typeof e.identity !== "string" ||
        !["ok", "not-found", "ambiguous", "error"].includes(e.status) ||
        !Number.isFinite(e.checkedAt) ||
        !Number.isFinite(e.retryAt) ||
        !Number.isFinite(new Date(e.checkedAt).getTime()) ||
        !Number.isFinite(new Date(e.retryAt).getTime()) ||
        e.checkedAt < 0 ||
        e.retryAt < 0 ||
        (e.result !== undefined && !validResult(e.result)) ||
        (e.status === "ok" && !e.result) ||
        (e.error !== undefined && typeof e.error !== "string")
      )
        continue;
      if (e.boundPaperID !== undefined && !normalizeOpenAlexID(e.boundPaperID))
        continue;
      if (e.detail !== undefined && typeof e.detail !== "string") continue;
      // Old misses must not suppress the repaired matching policy for a day.
      if (
        store.version === 1 &&
        ["not-found", "ambiguous"].includes(e.status) &&
        !e.result
      )
        continue;
      // Candidate previews are refreshed on demand, rather than trusted from disk.
      delete e.candidates;
      // Drop retired-provider failures so they cannot delay OpenAlex queries.
      // Preserve a previous OpenAlex success if a fallback request had failed.
      if (
        e.error?.includes("semantic-scholar") &&
        e.result?.source !== "manual"
      ) {
        if (!e.result) continue;
        entries.set(key, { ...e, status: "ok", retryAt: 0, error: undefined });
      } else entries.set(key, e);
    }
  } catch {
    // Damaged/older cache must never prevent the plugin from starting.
  }
  return entries;
}

export class CitationService {
  private entries = new Map<string, RecordEntry>();
  private pending = new Map<
    string,
    { identity: string; promise: Promise<void> }
  >();
  private generations = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private options: {
      provider: Provider;
      now: () => number;
      ttl: () => number;
      changed: (key: string) => void;
    },
  ) {}

  load(raw: string) {
    this.entries = parseCache(raw);
  }
  serialize(): string {
    return JSON.stringify({
      version: 2,
      items: Object.fromEntries(this.entries),
    });
  }
  get(identity: Identity): RecordEntry | undefined {
    const entry = this.entries.get(identity.key);
    return entry?.identity === fingerprint(identity) ? entry : undefined;
  }
  isPending(identity: Identity): boolean {
    return this.pending.get(identity.key)?.identity === fingerprint(identity);
  }
  isStale(entry: RecordEntry): boolean {
    return (
      entry.result?.source !== "manual" &&
      (!entry.result ||
        this.options.now() - entry.result.updatedAt >= this.options.ttl())
    );
  }

  refresh(identity: Identity, force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    const signature = fingerprint(identity);
    const entry = this.get(identity);
    if (entry?.result?.source === "manual") return Promise.resolve();
    if (
      !force &&
      entry &&
      this.options.now() < entry.retryAt &&
      (entry.status !== "ok" || !this.isStale(entry))
    )
      return Promise.resolve();
    const existing = this.pending.get(identity.key);
    if (existing?.identity === signature) return existing.promise;
    // Bound automatic work when Zotero evaluates an entire large library.
    if (!force && this.pending.size >= 200) return Promise.resolve();
    const generation = (this.generations.get(identity.key) || 0) + 1;
    this.generations.set(identity.key, generation);
    const work = this.tail
      .then(async () => {
        if (this.closed || this.generations.get(identity.key) !== generation)
          return;
        let next: RecordEntry;
        try {
          const response = await this.options.provider.lookup(
            identity,
            entry?.boundPaperID,
          );
          const now = this.options.now();
          next = {
            identity: signature,
            status: response.status,
            checkedAt: now,
            retryAt:
              now + (response.status === "ok" ? this.options.ttl() : DAY),
            result: response.result
              ? { ...response.result, updatedAt: now }
              : entry?.result,
            detail: response.detail,
            candidates: response.candidates,
            boundPaperID: entry?.boundPaperID,
          };
        } catch (error) {
          const now = this.options.now();
          next = {
            identity: signature,
            status: "error",
            checkedAt: now,
            retryAt: now + 15 * 60_000,
            result: entry?.result,
            // Provider errors contain only sanitized messages, never request URLs/keys.
            error: error instanceof Error ? error.message : "查询失败",
            candidates: entry?.candidates,
            boundPaperID: entry?.boundPaperID,
            detail: entry?.detail,
          };
        }
        if (this.closed || this.generations.get(identity.key) !== generation)
          return;
        this.entries.set(identity.key, next);
        this.options.changed(identity.key);
      })
      .finally(() => {
        if (this.pending.get(identity.key)?.promise === work)
          this.pending.delete(identity.key);
      });
    this.pending.set(identity.key, { identity: signature, promise: work });
    this.tail = work.catch(() => {});
    return work;
  }

  setManual(identity: Identity, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("请输入非负整数");
    this.invalidate(identity.key);
    const now = this.options.now();
    this.entries.set(identity.key, {
      identity: fingerprint(identity),
      status: "ok",
      checkedAt: now,
      retryAt: now,
      result: {
        count,
        source: "manual",
        paperID: "",
        url: "",
        matchedBy: "manual",
        updatedAt: now,
      },
    });
    this.options.changed(identity.key);
  }

  /** Candidate searches share the queue but cannot replace a displayed result. */
  findCandidates(identity: Identity): Promise<Lookup> {
    const work = this.tail.then(async () => {
      if (this.closed) throw new Error("查询已停止");
      return this.options.provider.lookup(identity);
    });
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }

  confirmCandidate(identity: Identity, candidate: Candidate): void {
    const paperID = normalizeOpenAlexID(candidate.id);
    if (
      this.closed ||
      !paperID ||
      !Number.isSafeInteger(candidate.count) ||
      candidate.count < 0
    )
      throw new Error("候选记录无效");
    this.invalidate(identity.key);
    const now = this.options.now();
    this.entries.set(identity.key, {
      identity: fingerprint(identity),
      status: "ok",
      checkedAt: now,
      retryAt: now + this.options.ttl(),
      boundPaperID: paperID,
      result: {
        count: candidate.count,
        source: "openalex",
        paperID,
        url: paperID,
        matchedBy: "confirmed",
        updatedAt: now,
      },
      detail: "已由用户确认论文，后续按 OpenAlex 记录更新",
    });
    this.options.changed(identity.key);
  }

  remove(key: string): void {
    this.invalidate(key);
    this.entries.delete(key);
    this.options.changed(key);
  }
  private invalidate(key: string): void {
    this.generations.set(key, (this.generations.get(key) || 0) + 1);
    this.pending.delete(key);
  }
  cancelPending(): void {
    for (const key of this.pending.keys()) this.invalidate(key);
  }
  stop(): void {
    this.closed = true;
  }
}
