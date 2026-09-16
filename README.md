# Prism

A curated news surface that aggregates social platforms and newsroom
feeds into one ranked, attributed stream.

## Repo layout

    public/           Frontend (static HTML) → deployed to Cloudflare Pages
    worker/           Backend (Cloudflare Worker) → deployed to Cloudflare Workers

## Live URL

- Frontend:  https://prism.pages.dev        (or your custom domain)
- Backend:   https://prism-api.YOUR-SUBDOMAIN.workers.dev

## How it works

1. The Worker runs on a 10-minute cron, fetches from Reddit + RSS + Hacker News,
   deduplicates similar stories, and ranks them by velocity.
2. Results are cached in KV (if bound) and served at `/feed`.
3. The frontend fetches `/feed` and renders the ranked stream.

Every story card links back to its original publisher. No content is rehosted.

## Deploying your own copy

### 1. Frontend (Cloudflare Pages)

- Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
- Pick this repo
- **Build command:** *(leave empty)*
- **Build output directory:** `public`
- Click **Save and Deploy**

You'll get a URL like `https://prism-xyz.pages.dev`.

### 2. Backend (Cloudflare Workers)

- Cloudflare dashboard → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**
- Pick this repo
- **Root directory:** `worker`
- Click **Deploy**

You'll get a URL like `https://prism-api.YOUR-NAME.workers.dev`.

### 3. (Optional) Add a KV cache

Without KV, the Worker still works — it just re-fetches on every request.
For automatic caching:

- Cloudflare dashboard → **Workers & Pages** → **KV** → **Create namespace** → name it `PRISM_CACHE`
- Back in the Worker project → **Settings** → **Variables and Secrets** → **Add** → **KV Namespace Binding**
- Variable name: `PRISM_CACHE`
- Pick the namespace you just created

### 4. Wire the frontend to the backend

Edit `public/index.html`. Find near the bottom:

    const API_URL = '';

Set it to your Worker URL + `/feed`:

    const API_URL = 'https://prism-api.YOUR-NAME.workers.dev/feed';

Commit and push. Pages auto-redeploys in ~30 seconds.

## License

MIT
