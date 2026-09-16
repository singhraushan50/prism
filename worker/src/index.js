/**
 * Prism API — single-file Cloudflare Worker.
 *
 * Endpoints:
 *   GET /feed      → { generatedAt, count, stories[] }
 *   GET /refresh   → force re-ingest, returns { ok, count }
 *   GET /healthz   → "ok"
 *
 * KV binding is optional. If PRISM_CACHE is bound, results are cached.
 * If not, every request re-ingests (still works, just slower).
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/healthz') return new Response('ok\n');

    if (url.pathname === '/feed') {
      let data = await getCached(env);
      if (!data) {
        data = await refresh(env);
      }
      return Response.json(data, {
        headers: { ...cors, 'Cache-Control': 'public, max-age=120' },
      });
    }

    if (url.pathname === '/refresh') {
      const fresh = await refresh(env);
      return Response.json({ ok: true, count: fresh.stories.length }, { headers: cors });
    }

    return new Response('Prism API. Try /feed\n', { headers: cors });
  },
};

// ─── KV helpers (safe when KV isn't bound) ──────────────
async function getCached(env) {
  if (!env.PRISM_CACHE) return null;
  try {
    return await env.PRISM_CACHE.get('feed', 'json');
  } catch {
    return null;
  }
}

async function setCached(env, data) {
  if (!env.PRISM_CACHE) return;
  try {
    await env.PRISM_CACHE.put('feed', JSON.stringify(data), {
      expirationTtl: Number(env.CACHE_TTL || 600),
    });
  } catch {
    // Ignore KV errors — the response still goes out
  }
}

// ─── Orchestrator ───────────────────────────────────────
async function refresh(env) {
  const t0 = Date.now();

  const [reddit, rss, hn] = await Promise.all([
    fetchReddit().catch(e => (console.warn('reddit:', e.message), [])),
    fetchRSS().catch(e => (console.warn('rss:', e.message), [])),
    fetchHN().catch(e => (console.warn('hn:', e.message), [])),
  ]);

  console.log(`fetched  reddit=${reddit.length}  rss=${rss.length}  hn=${hn.length}`);

  const merged = [...reddit, ...rss, ...hn];
  const ranked = rank(dedupe(merged));

  const payload = {
    generatedAt: new Date().toISOString(),
    count: ranked.length,
    stories: ranked.slice(0, 60).map(shape),
  };

  await setCached(env, payload);

  console.log(`refresh done in ${Date.now() - t0}ms → ${payload.stories.length} stories`);
  return payload;
}

// ─── Reddit ─────────────────────────────────────────────
const SUBS = [
  ['worldnews',  'World'],
  ['technology', 'Tech'],
  ['science',    'Science'],
  ['business',   'Business'],
];

async function fetchReddit() {
  const out = [];
  for (const [sub, cat] of SUBS) {
    try {
      const res = await fetch(
        `https://www.reddit.com/r/${sub}/hot.json?limit=8&raw_json=1`,
        { headers: { 'User-Agent': 'prism-news/1.0' } }
      );
      if (!res.ok) { console.warn(`r/${sub} → ${res.status}`); continue; }
      const json = await res.json();
      for (const { data: p } of json?.data?.children || []) {
        if (p.stickied) continue;
        out.push({
          platform: 'reddit',
          source: `r/${sub}`,
          handle: `u/${p.author}`,
          cat,
          title: p.title,
          summary: (p.selftext || '').slice(0, 320) || `Discussion on r/${sub}`,
          url: `https://reddit.com${p.permalink}`,
          image: redditImage(p),
          metrics: { likes: p.score || 0, comments: p.num_comments || 0 },
          publishedAt: new Date((p.created_utc || 0) * 1000).toISOString(),
          seed: p.id,
        });
      }
      await sleep(900);
    } catch (e) {
      console.warn(`r/${sub} failed:`, e.message);
    }
  }
  return out;
}

function redditImage(p) {
  const prev = p?.preview?.images?.[0]?.source?.url;
  if (prev) return prev.replace(/&amp;/g, '&');
  if (p.url_overridden_by_dest && /\.(jpe?g|png|webp|gif)$/i.test(p.url_overridden_by_dest))
    return p.url_overridden_by_dest;
  if (p.thumbnail?.startsWith('http')) return p.thumbnail;
  return null;
}

// ─── RSS ────────────────────────────────────────────────
const FEEDS = [
  ['https://feeds.bbci.co.uk/news/world/rss.xml',                'BBC News',    'World',    true],
  ['https://www.aljazeera.com/xml/rss/all.xml',                  'Al Jazeera',  'World',    true],
  ['https://feeds.npr.org/1004/rss.xml',                         'NPR',         'World',    true],
  ['https://www.theverge.com/rss/index.xml',                     'The Verge',   'Tech',     true],
  ['https://techcrunch.com/feed/',                               'TechCrunch',  'Tech',     true],
  ['https://www.wired.com/feed/rss',                             'WIRED',       'Tech',     true],
  ['https://www.nature.com/nature.rss',                          'Nature',      'Science',  true],
  ['https://phys.org/rss-feed/',                                 'Phys.org',    'Science',  false],
  ['https://feeds.bloomberg.com/markets/news.rss',               'Bloomberg',   'Business', true],
  ['https://www.theguardian.com/culture/rss',                    'The Guardian','Culture',  true],
  ['https://www.theguardian.com/environment/climate-crisis/rss', 'The Guardian','Climate',  true],
  ['https://insideclimatenews.org/feed/',                        'Inside Climate News', 'Climate', true],
];

async function fetchRSS() {
  const out = [];
  const results = await Promise.allSettled(
    FEEDS.map(([url, source, cat, verified]) => oneFeed(url, source, cat, verified))
  );
  for (const r of results) if (r.status === 'fulfilled') out.push(...r.value);
  return out;
}

async function oneFeed(url, source, cat, verified) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'prism-news/1.0',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) { console.warn(`rss ${source} → ${res.status}`); return []; }

    const xml = await res.text();
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g)
                || xml.match(/<entry[\s>][\s\S]*?<\/entry>/g)
                || [];

    return blocks.slice(0, 10).map(block => {
      const title = clean(pick(block, 'title'));
      const link  = clean(pickLink(block));
      const desc  = clean(pick(block, 'description') || pick(block, 'summary'));
      const date  = pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated');

      return {
        platform: 'web',
        source,
        verified,
        handle: '@' + source.toLowerCase().replace(/[^a-z0-9]/g, ''),
        cat,
        title,
        summary: truncate(desc, 340) || title,
        url: link,
        image: pickImage(block),
        metrics: { likes: 0, comments: 0 },
        publishedAt: date ? new Date(date).toISOString() : new Date().toISOString(),
        seed: slug(source + '-' + title),
      };
    }).filter(s => s.title && s.url);
  } catch {
    return [];
  }
}

function pick(block, tag) {
  const esc = tag.replace(':', '\\:');
  const m = block.match(new RegExp(`<${esc}[^>]*>([\\s\\S]*?)<\\/${esc}>`, 'i'));
  return m ? m[1] : '';
}
function pickLink(block) {
  return (block.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1] || pick(block, 'link');
}
function pickImage(block) {
  return (block.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i) || [])[1]
      || (block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i) || [])[1]
      || (block.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1]
      || null;
}
function clean(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : (s || '');
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ─── Hacker News ────────────────────────────────────────
async function fetchHN() {
  const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
  if (!res.ok) throw new Error('hn topstories ' + res.status);
  const ids = (await res.json()).slice(0, 25);

  const items = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const got = await Promise.all(
      batch.map(id => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
        .then(r => r.ok ? r.json() : null))
    );
    got.forEach(x => x && items.push(x));
  }

  return items
    .filter(it => it.type === 'story' && it.title)
    .map(it => ({
      platform: 'hn',
      source: 'Hacker News',
      handle: it.by ? `@${it.by}` : 'news.ycombinator.com',
      cat: guessCat(it.title),
      title: it.title,
      summary: it.text
        ? clean(it.text).slice(0, 320)
        : `Discussion on Hacker News · ${it.descendants || 0} comments`,
      url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
      image: null,
      metrics: { likes: it.score || 0, comments: it.descendants || 0 },
      publishedAt: new Date((it.time || 0) * 1000).toISOString(),
      seed: `hn-${it.id}`,
    }));
}

function guessCat(t) {
  t = t.toLowerCase();
  if (/\b(ai|llm|gpt|model|compiler|kernel|rust|python|javascript)\b/.test(t)) return 'Tech';
  if (/\b(space|physics|biology|genome|telescope|quantum)\b/.test(t)) return 'Science';
  if (/\b(market|startup|funding|ipo|acquisition)\b/.test(t)) return 'Business';
  return 'Tech';
}

// ─── Dedupe + rank + shape ──────────────────────────────
function dedupe(stories) {
  const kept = [];
  const STOP = new Set(['the','a','an','of','to','in','on','for','and','or','is','are','was','with','at','by','from','as','that','this','it','its']);

  const tokenize = s => new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w))
  );
  const jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };

  for (const story of stories) {
    const tokens = tokenize(story.title);
    if (!tokens.size) { kept.push(story); continue; }

    let dup = null;
    for (const existing of kept) {
      if (existing.cat !== story.cat) continue;
      if (jaccard(tokens, tokenize(existing.title)) >= 0.62) { dup = existing; break; }
    }

    if (dup) {
      dup.corroboratedBy = dup.corroboratedBy || [];
      dup.corroboratedBy.push({ source: story.source, platform: story.platform, url: story.url });
      const scoreOf = s => (s.metrics?.likes || 0) + (s.metrics?.comments || 0) * 2;
      if (scoreOf(story) > scoreOf(dup)) {
        Object.assign(dup, {
          title: story.title, summary: story.summary, url: story.url,
          image: story.image || dup.image, metrics: story.metrics,
          platform: story.platform, source: story.source,
          verified: story.verified, publishedAt: story.publishedAt,
        });
      }
    } else {
      kept.push(story);
    }
  }
  return kept;
}

function rank(stories) {
  const now = Date.now();
  return stories
    .map(s => {
      const ageMin = Math.max(1, (now - new Date(s.publishedAt).getTime()) / 60000);
      const eng = (s.metrics?.likes || 0) + (s.metrics?.comments || 0) * 2;
      const velocity = eng / ageMin;
      const recency = ageMin < 30 ? 2.2 : ageMin < 120 ? 1.5 : ageMin < 360 ? 1.15 : 1.0;
      const corroboration = 1 + Math.min(0.5, (s.corroboratedBy?.length || 0) * 0.15);
      const trust = s.verified ? 1.25 : 1.0;
      return {
        ...s,
        score: velocity * recency * corroboration * trust,
        ageMinutes: Math.round(ageMin),
        velocity: Math.round(velocity * 10) / 10,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function shape(s) {
  return {
    id: s.seed,
    platform: s.platform,
    source: s.source,
    handle: s.handle,
    time: s.ageMinutes,
    seed: s.seed,
    title: s.title,
    summary: s.summary,
    metrics: s.metrics,
    cat: s.cat,
    verified: s.verified || false,
    channel: s.platform === 'web',
    url: s.url,
    image: s.image,
    velocity: s.velocity,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
