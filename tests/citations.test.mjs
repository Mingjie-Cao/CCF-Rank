import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CitationService,
  DAY,
  countSortKey,
  fingerprint,
  matchCandidates,
  normalizeDOI,
  normalizeTitle,
  parseCache,
} from "../.scaffold/citation-tests/core.js";
import {
  CitationHTTP,
  OpenAlexProvider,
} from "../.scaffold/citation-tests/providers.js";

const identity = {
  key: "1:ABC123",
  doi: "10.1234/example",
  title: "Attention Is All You Need",
  year: 2017,
  author: "Vaswani",
};
const candidate = {
  id: "W1",
  doi: identity.doi,
  title: identity.title,
  year: 2017,
  authors: ["Ashish Vaswani"],
  count: 0,
  url: "https://openalex.org/W1",
};
const ok = (count = 12) => ({
  status: "ok",
  result: {
    count,
    source: "openalex",
    paperID: "W1",
    url: candidate.url,
    matchedBy: "doi",
  },
});
function service(provider = { lookup: async () => ok() }) {
  let now = 1000;
  let ttl = 7 * DAY;
  let changes = 0;
  const s = new CitationService({
    provider,
    now: () => now,
    ttl: () => ttl,
    changed: () => changes++,
  });
  return {
    s,
    advance: (ms) => (now += ms),
    ttl: (ms) => (ttl = ms),
    changes: () => changes,
  };
}
function transport(responses) {
  let now = 0;
  const calls = [];
  const sleeps = [];
  const http = new CitationHTTP(
    async (url, headers) => {
      calls.push({ url, headers, time: now });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("Unexpected request");
      return response;
    },
    () => now,
    async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    () => true,
  );
  return { http, calls, sleeps };
}
const oa = (extra = {}) => ({
  id: "https://openalex.org/W1",
  doi: `https://doi.org/${identity.doi}`,
  display_name: identity.title,
  publication_year: 2017,
  cited_by_count: 0,
  authorships: [{ author: { display_name: "Ashish Vaswani" } }],
  ...extra,
});
function openAlex(http) {
  return new OpenAlexProvider(http, () => ({
    openAlexKey: "oa-secret",
  }));
}

test("DOI URLs, prefixes, encoding and case normalize; invalid identifiers are rejected", () => {
  for (const doi of [
    " DOI: 10.1234/Example ",
    "https://dx.doi.org/10.1234/Example",
    "https://doi.org/10.1234%2FExample",
  ])
    assert.equal(normalizeDOI(doi), identity.doi);
  for (const bad of ["", "not-a-doi", "10.12/x", "10.1234/a b", "10.1234/%ZZ"])
    assert.equal(normalizeDOI(bad), undefined);
});
test("Unicode title normalization preserves non-Latin distinctions", () => {
  assert.equal(
    normalizeTitle("Ａttention—Is All You Need!"),
    normalizeTitle(identity.title),
  );
  assert.notEqual(
    normalizeTitle("图神经网络研究"),
    normalizeTitle("量子计算研究"),
  );
});
test("DOI outranks changed title/year; zero is a valid count", () => {
  assert.equal(
    matchCandidates(identity, [
      { ...candidate, title: "Alternate title", year: 2020 },
    ]).matchedBy,
    "doi",
  );
  assert.equal(matchCandidates(identity, [candidate]).candidate.count, 0);
});
test("title fallback requires corroboration and sends conflicting metadata to confirmation", () => {
  const noDOI = { ...identity, doi: undefined };
  assert.equal(matchCandidates(noDOI, [candidate]).matchedBy, "title");
  assert.equal(
    matchCandidates(noDOI, [{ ...candidate, year: 2018 }]).status,
    "ambiguous",
  );
  assert.equal(
    matchCandidates(noDOI, [{ ...candidate, authors: ["Another Person"] }])
      .status,
    "ambiguous",
  );
  assert.equal(
    matchCandidates(identity, [{ ...candidate, doi: "10.1234/wrong" }]).status,
    "ambiguous",
  );
  assert.equal(
    matchCandidates({ ...noDOI, year: undefined, author: undefined }, [
      candidate,
    ]).status,
    "ambiguous",
  );
});
test("same-title ambiguity is never resolved by citation count; duplicate IDs deduplicate", () => {
  assert.equal(
    matchCandidates({ ...identity, doi: undefined }, [
      candidate,
      { ...candidate, id: "W2", count: 99999 },
    ]).status,
    "ambiguous",
  );
  assert.equal(matchCandidates(identity, [candidate, candidate]).status, "ok");
});
test("count sort keys order 0, 2, 10, 100 and large integers correctly", () => {
  assert.deepEqual(
    [100, 10, 0, Number.MAX_SAFE_INTEGER, 2]
      .map(countSortKey)
      .sort()
      .map(Number),
    [0, 2, 10, 100, Number.MAX_SAFE_INTEGER],
  );
});
test("single-flight, positive cache expiry, force refresh and round-trip persistence", async () => {
  let calls = 0;
  const { s, advance } = service({
    lookup: async () => {
      calls++;
      return ok(0);
    },
  });
  await Promise.all([
    s.refresh(identity),
    s.refresh(identity),
    s.refresh(identity),
  ]);
  assert.equal(calls, 1);
  await s.refresh(identity);
  assert.equal(calls, 1);
  advance(7 * DAY);
  await s.refresh(identity);
  assert.equal(calls, 2);
  await s.refresh(identity, true);
  assert.equal(calls, 3);
  const restored = service().s;
  restored.load(s.serialize());
  assert.equal(restored.get(identity).result.count, 0);
});
test("metadata and library keys isolate cache; shortening TTL takes effect immediately", async () => {
  const { s, advance, ttl } = service();
  await s.refresh(identity);
  for (const changed of [
    { year: 2018 },
    { title: "Another title" },
    { doi: "10.1234/new" },
    { author: "Other" },
    { key: "2:ABC123" },
  ])
    assert.equal(s.get({ ...identity, ...changed }), undefined);
  advance(2 * DAY);
  ttl(DAY);
  await s.refresh(identity);
  assert.equal(s.get(identity).result.updatedAt, 1000 + 2 * DAY);
});
test("negative/ambiguous records wait one day, errors wait fifteen minutes", async () => {
  for (const status of ["not-found", "ambiguous", "error"]) {
    let calls = 0;
    const { s, advance } = service({
      lookup: async () => {
        calls++;
        if (status === "error") throw new Error("offline");
        return { status };
      },
    });
    await s.refresh(identity);
    await s.refresh(identity);
    assert.equal(calls, 1);
    advance(status === "error" ? 15 * 60_000 : DAY);
    await s.refresh(identity);
    assert.equal(calls, 2);
  }
});
test("failed refresh preserves prior count/source/timestamp; later lower counts are accepted", async () => {
  let response = ok(100);
  const { s, advance } = service({
    lookup: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
  });
  await s.refresh(identity);
  const prior = s.get(identity).result;
  advance(7 * DAY);
  response = new Error("offline");
  await s.refresh(identity);
  assert.equal(s.get(identity).status, "error");
  assert.deepEqual(s.get(identity).result, prior);
  response = ok(90);
  await s.refresh(identity, true);
  assert.equal(s.get(identity).result.count, 90);
});
test("manual override survives force refresh, validation and persistence", async () => {
  let calls = 0;
  const { s } = service({
    lookup: async () => {
      calls++;
      return ok();
    },
  });
  s.setManual(identity, 0);
  await s.refresh(identity, true);
  assert.equal(calls, 0);
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => s.setManual(identity, value));
  const restored = service().s;
  restored.load(s.serialize());
  assert.equal(restored.get(identity).result.source, "manual");
  s.remove(identity.key);
  await s.refresh(identity);
  assert.equal(calls, 1);
});
test("manual/deletion/cancellation/shutdown prevent in-flight responses from overwriting state", async () => {
  for (const action of ["manual", "remove", "cancel", "stop"]) {
    let resolve;
    const { s } = service({ lookup: () => new Promise((r) => (resolve = r)) });
    const work = s.refresh(identity);
    await Promise.resolve();
    if (action === "manual") s.setManual(identity, 55);
    if (action === "remove") s.remove(identity.key);
    if (action === "cancel") s.cancelPending();
    if (action === "stop") s.stop();
    resolve(ok(1));
    await work;
    if (action === "manual") assert.equal(s.get(identity).result.count, 55);
    else assert.equal(s.get(identity), undefined);
  }
});
test("changed metadata during a request replaces older result without races", async () => {
  let resolve;
  let calls = 0;
  const { s } = service({
    lookup: () =>
      ++calls === 1
        ? new Promise((r) => (resolve = r))
        : Promise.resolve(ok(22)),
  });
  const first = s.refresh(identity);
  await Promise.resolve();
  const changed = { ...identity, title: "A newly corrected title" };
  const second = s.refresh(changed);
  resolve(ok(11));
  await Promise.all([first, second]);
  assert.equal(s.get(changed).result.count, 22);
  assert.equal(s.get(identity), undefined);
});
test("serial queue has one active lookup and is bounded", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const { s } = service({
    lookup: async () => {
      calls++;
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
      return ok();
    },
  });
  await Promise.all(
    Array.from({ length: 250 }, (_, i) =>
      s.refresh({ ...identity, key: `1:${i}` }),
    ),
  );
  assert.equal(maximum, 1);
  assert.equal(calls, 200);
});
test("corrupt/unknown cache schemas and invalid entries are ignored", () => {
  for (const raw of [
    "bad json",
    "null",
    '{"version":2,"items":{}}',
    '{"version":1,"items":{"a":null}}',
  ])
    assert.equal(parseCache(raw).size, 0);
  const valid = {
    identity: fingerprint(identity),
    status: "ok",
    checkedAt: 0,
    retryAt: 0,
    result: { ...ok().result, updatedAt: 0 },
  };
  const corrupt = { ...valid, result: { ...valid.result, count: -1 } };
  const invalidDate = {
    ...valid,
    result: { ...valid.result, updatedAt: 1e100 },
  };
  assert.equal(
    parseCache(
      JSON.stringify({ version: 1, items: { valid, corrupt, invalidDate } }),
    ).size,
    1,
  );
});
test("OpenAlex success returns zero and sends the key only in the header", async () => {
  const { http, calls } = transport([{ status: 200, data: oa() }]);
  const result = await openAlex(http).lookup(identity);
  assert.equal(result.result.count, 0);
  assert.equal(result.result.source, "openalex");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, "Bearer oa-secret");
  assert.ok(
    calls[0].url.includes(
      encodeURIComponent(`https://doi.org/${identity.doi}`),
    ),
  );
  assert.ok(!calls[0].url.includes("secret"));
});
test("DOI 404 falls back to exact corroborated title search", async () => {
  const { http, calls } = transport([
    { status: 404 },
    { status: 200, data: { meta: { count: 1 }, results: [oa()] } },
  ]);
  const result = await openAlex(http).lookup(identity);
  assert.equal(result.status, "ok");
  assert.ok(calls[1].url.includes("search.title=%22"));
  assert.ok(calls[1].time - calls[0].time >= 1100);
});
test("OpenAlex outage retries once and never contacts another provider", async () => {
  const { http, calls } = transport([{ status: 503 }, { status: 503 }]);
  await assert.rejects(openAlex(http).lookup(identity), /HTTP 503/);
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every((call) => call.url.startsWith("https://api.openalex.org/")),
  );
});
test("authentication and invalid counts report errors without secrets or fallback", async () => {
  for (const response of [
    { status: 401 },
    { status: 200, data: oa({ cited_by_count: null }) },
  ]) {
    const { http, calls } = transport([response]);
    await assert.rejects(
      openAlex(http).lookup(identity),
      (e) => !e.message.includes("secret"),
    );
    assert.equal(calls.length, 1);
  }
});
test("ambiguous and truncated title searches never accept the first hit", async () => {
  for (const data of [
    {
      meta: { count: 2 },
      results: [oa(), oa({ id: "https://openalex.org/W2" })],
    },
    { meta: { count: 100 }, results: [oa()] },
  ]) {
    const { http } = transport([{ status: 200, data }]);
    assert.equal(
      (await openAlex(http).lookup({ ...identity, doi: undefined })).status,
      "ambiguous",
    );
  }
});
test("429 honors Retry-After; long cooldowns do not block the batch and suppress repeat requests", async () => {
  const short = transport([
    { status: 429, retryAfter: "5" },
    { status: 200, data: {} },
  ]);
  await short.http.get("oa", "https://example.org", {});
  assert.ok(short.calls[1].time >= 5000);
  const long = transport([{ status: 429, retryAfter: "3600" }]);
  await assert.rejects(long.http.get("oa", "https://example.org", {}));
  await assert.rejects(long.http.get("oa", "https://example.org", {}));
  assert.equal(long.calls.length, 1);
});
test("network retries are bounded, stop is respected and remote error text is sanitized", async () => {
  const { http, calls } = transport([
    new Error("secret URL"),
    new Error("secret URL"),
  ]);
  await assert.rejects(
    http.get("oa", "url", {}),
    (e) => !e.message.includes("secret"),
  );
  assert.equal(calls.length, 2);
  let fetched = false;
  const stopped = new CitationHTTP(
    async () => {
      fetched = true;
    },
    Date.now,
    async () => {},
    () => false,
  );
  await assert.rejects(stopped.get("oa", "url", {}));
  assert.equal(fetched, false);
});
