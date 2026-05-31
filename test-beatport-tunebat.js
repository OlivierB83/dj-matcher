/**
 * Honest scoping of Beatport + Tunebat before committing $$$:
 *   - Beatport: try the public search endpoint. Confirm coverage gap on
 *     non-electronic tracks. Confirm coverage win on electronic ones.
 *   - Tunebat: similar — they aggregate Mixed-In-Key-quality data for
 *     a wide DJ-focused catalog.
 */

const TRACKS = [
  // Electronic (likely in Beatport)
  { q: "Daft Punk One More Time",                  type: "electronic" },
  { q: "Calvin Harris Dua Lipa One Kiss",          type: "electronic" },
  { q: "Purple Disco Machine Hypnotized",          type: "electronic" },
  { q: "Lost Frequencies Never Going Home",        type: "electronic" },
  { q: "Robin Schulz Prayer In C",                 type: "electronic" },
  // Mainstream pop/rock/world (unlikely in Beatport, expected gap)
  { q: "Michael Jackson Billie Jean",              type: "pop" },
  { q: "Men at Work Down Under",                   type: "rock" },
  { q: "Wham Wake Me Up Before You Go-Go",         type: "pop" },
  { q: "Pearl Jam Wreckage",                       type: "rock" },
  { q: "Elton John I'm Still Standing",            type: "pop" },
];

async function probeBeatport(q) {
  // Beatport's public-facing search (used by their site)
  const url = `https://api.beatport.com/v4/catalog/search/?q=${encodeURIComponent(q)}&per_page=1&type=tracks`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, http: r.status };
    const data = await r.json();
    return {
      ok: true,
      http: r.status,
      hits: data.tracks?.results?.length || data.tracks?.count || 0,
      first: data.tracks?.results?.[0] || data.tracks?.[0] || null,
    };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function probeTunebat(q) {
  // Tunebat web search — they expose a public-ish endpoint
  const url = `https://api.tunebat.com/api/tracks/search?term=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 dj-matcher-test/0.1",
        "Accept": "application/json",
      },
    });
    return { http: r.status, body: (await r.text()).slice(0, 400) };
  } catch (e) {
    return { err: e.message };
  }
}

async function main() {
  console.log("\n=== Beatport ===\n");
  for (const t of TRACKS) {
    const res = await probeBeatport(t.q);
    const status = res.ok ? `HTTP ${res.http} · hits=${res.hits}` : (res.http ? `HTTP ${res.http}` : `ERR ${res.err}`);
    let first = "";
    if (res.first) {
      const tr = res.first;
      first = ` · "${tr.name || tr.track_name || tr.title}" / BPM=${tr.bpm} key=${tr.key?.camelot_number || tr.key?.name || tr.key}`;
    }
    console.log(`  [${t.type.padEnd(10)}] ${t.q.padEnd(40)} → ${status}${first}`);
  }

  console.log("\n=== Tunebat ===\n");
  for (const t of TRACKS.slice(0, 5)) {
    const res = await probeTunebat(t.q);
    const out = res.http ? `HTTP ${res.http} · ${res.body}` : `ERR ${res.err}`;
    console.log(`  [${t.type}] ${t.q}`);
    console.log(`    ${out.slice(0, 300)}`);
  }
}

main().catch(console.error);
