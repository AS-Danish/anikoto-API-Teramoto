<div align="center">
  <h1>Anikoto API</h1>
  
  <p><strong>A high-performance REST API for scraping anime data from anikoto.net, built with Next.js 16</strong></p>

  <p>
    <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FTeramoto669%2Fanikoto-scrap-api"><img src="https://vercel.com/button" alt="Deploy with Vercel"></a>
    <img src="https://img.shields.io/badge/Next.js-16-black?style=flat&logo=next.js" alt="Next.js 16">
    <img src="https://img.shields.io/badge/TypeScript-5.0-blue?style=flat&logo=typescript" alt="TypeScript">
    <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License MIT">
  </p>

  <p>Author: <strong>Teramoto</strong></p>

  <p>
    <a href="#-features">Features</a> • 
    <a href="#-getting-started">Quick Start</a> • 
    <a href="#-api-overview">API Endpoints</a> • 
    <a href="#%EF%B8%8F-project-structure">Project Structure</a> • 
    <a href="#%E2%98%81%EF%B8%8F-cloudflare-worker-proxy-optional">Deployment</a>
  </p>
</div>

> **For educational purposes only.** This project is not affiliated with anikoto.net.

> [!IMPORTANT]
>
> 1. There was previously a hosted version of this API for showcasing purposes only, and it was misused; It is recommended to deploy your own instance for personal use by customizing the API as you need it to be.
> 2. This API is just an unofficial API for [anikoto.net](https://anikoto.net) and is in no other way officially related to the same.
> 3. The content that this API provides is not mine, nor is it hosted by me. These belong to their respective owners. This API just demonstrates how to build an API that scrapes websites and uses their content.

---

## ✨ Features

- 15 REST endpoints covering home, search, filter, anime detail, episodes, related, recommendations, tooltip, schedule, streaming sources (with opening/ending skip ranges), and a streaming proxy
- Response envelope — every response is `{ ok: true, data: ... }` or `{ ok: false, message: "..." }`
- In-memory cache (TTL per endpoint) — add `?refresh=1` to any request to bypass
- Interactive **Swagger UI** docs at `/` powered by an OpenAPI 3.0 spec (`public/openapi.yaml`)
- TypeScript — fully typed responses via `src/lib/types.ts`

---

## 🚀 Getting Started

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the interactive API docs.

---

## 📖 API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/home` | Home data: spotlight, latest eps, top anime |
| GET | `/api/search?keyword=&page=` | Search anime by keyword (paginated) |
| GET | `/api/filter` | Advanced multi-param filter (paginated, returns `results` & optional `topRated`) |
| GET | `/api/anime/:slug` | Anime detail info (without related or recommendations) |
| GET | `/api/anime/:slug/episodes` | Episode list (with range filter) |
| GET | `/api/anime/:slug/related` | Related anime (watch order/sequels/prequels) |
| GET | `/api/anime/:slug/recommendations` | Recommended anime list (cards) |
| GET | `/api/anime/tooltip/:id` | Anime tooltip / preview info (by poster's `data-tip` ID) |
| GET | `/api/updated?page=` | Paginated latest updated anime listing directly from `https://anikoto.net/latest-updated` (returns `results` & optional `topRated`) |
| GET | `/api/widget?name=&page=` | Home AJAX widgets: `updated-all`, `updated-sub`, `updated-dub`, `trending`, `random` |
| GET | `/api/status?type=&page=` | Airing status listing: `currently-airing`, `finished-airing`, `not-yet-aired` (returns `results` & optional `topRated`) |
| GET | `/api/genre/:genre?page=` | Browse by genre slug (returns `results` & optional `topRated`) |
| GET | `/api/type/:type?page=` | Browse by media type: `tv`, `movie`, `ova`, `ona`, `special`, `music` (returns `results` & optional `topRated`) |
| GET | `/api/schedule?tz=&images=` | Weekly airing schedule (optional UTC tz offset in hours and image resolution) |
| GET | `/api/watch/:slug?ep=` | Streaming sources (m3u8, subtitles, and opening/ending skip ranges) |
| GET | `/api/proxy?url=&exp=&v=1&sig=` | Signed, allowlisted streaming proxy used by `/api/watch` |

See the **full interactive documentation** at `/` (when running locally) or in [`public/openapi.yaml`](./public/openapi.yaml).

---

## ⚡ Cache TTL

| Endpoint | TTL |
|----------|-----|
| `/api/home` | 5 minutes |
| `/api/anime/:slug` / `/api/anime/tooltip/:id` | 30 minutes |
| `/api/search` | 2 minutes |
| `/api/filter` | 5 minutes |
| `/api/schedule` | 1 hour |
| Episodes | 10 minutes |

Add `?refresh=1` and the server-only `x-cache-refresh-token` header to force a
fresh scrape. The value must match `CACHE_REFRESH_SECRET`; public callers cannot
bypass the cache.

> [!TIP]
> **Schedule Images:** By default, `/api/schedule` returns an empty string for anime images to keep response times fast (fetching schedule images requires visiting each anime details page). Setting `images=true` will concurrently fetch the poster images for all listed anime with a global concurrency limit of 5.

---

---

## ⚙️ Environment Variables

Configure environment variables in a `.env` file at the root directory:

```env
# Target base URL (default: https://anikoto.net)
BASE_URL=https://anikoto.net

# Exact browser origins only. Requests without Origin (server/native app) remain valid.
CORS_ALLOWED_ORIGIN=http://localhost:3000,https://your-luffy-tv-domain.example

# Hardened Cloudflare streaming proxy
CF_WORKER_URL=https://aonime-proxy.luffytv.workers.dev
PROXY_SIGNING_SECRET=replace-with-a-random-secret-of-at-least-32-characters
PROXY_URL_TTL_SECONDS=7200
APPROVED_STREAM_HOSTS=cdn.watching.onl,*.watching.onl,s1.akirax.buzz,*.akirax.buzz,*.mewstream.buzz,*.zaplume.buzz,*.megaplay.buzz,*.megacloud.tv,*.gogocdn.net,*.gogoplay4.com,*.vidstreaming.io,*.vidcloud9.com,*.embtaku.pro

# Recommended: shared cache for serverless/multi-instance deployments
UPSTASH_REDIS_REST_URL=https://your-database.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-server-only-token
CACHE_NAMESPACE=anikoto:v1
UPSTREAM_REQUESTS_PER_SECOND=8
UPSTREAM_MAX_CONCURRENCY=6

# Protects cache bypass requests
CACHE_REFRESH_SECRET=replace-with-a-long-random-secret
```

Successful catalog responses also include CDN cache directives. For high
traffic, place a CDN in front of the API, configure the shared Redis cache, and
restrict `CORS_ALLOWED_ORIGIN` to the production website. The memory-only
fallback is bounded and coalesces concurrent requests, but it is not shared
between separate serverless instances.

---

## ☁️ Hardened Cloudflare Worker Proxy

The API is the only component allowed to mint stream URLs. Every proxy URL is
HMAC-signed, expires after two hours by default, and binds the target URL,
referer, expiry, and signature version. The Worker also enforces exact CORS
origins, approved streaming hosts, private/local-address blocking, redirect
validation, and per-client burst and sustained rate limits.

1. Generate one 32-byte secret. On Windows PowerShell (including older Windows
   PowerShell versions):
   ```powershell
   $bytes = New-Object byte[] 32
   $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
   $rng.GetBytes($bytes)
   $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
   $rng.Dispose()
   $secret
   ```
2. Save the same value as `PROXY_SIGNING_SECRET` in the Vercel API project and
   in the Worker secret store. Never place it in the website or Flutter app:
   ```powershell
   cd cloudflare-worker
   npx wrangler@latest secret put PROXY_SIGNING_SECRET
   ```
3. In `cloudflare-worker/wrangler.jsonc`, replace `ALLOWED_CORS_ORIGINS` with
   the exact production Luffy TV origin plus the two localhost origins. Add a
   streaming hostname to `APPROVED_STREAM_HOSTS` only after observing it from a
   trusted provider response.
4. In Vercel, configure `CF_WORKER_URL`, `PROXY_SIGNING_SECRET`,
   `PROXY_URL_TTL_SECONDS`, `APPROVED_STREAM_HOSTS`, and exact
   `CORS_ALLOWED_ORIGIN` values from `.env.example`.
5. Deploy the API first, then deploy the Worker:
   ```powershell
   cd cloudflare-worker
   npm run check
   npm run deploy
   ```

During secret rotation, set the old Worker value as
`PROXY_SIGNING_SECRET_PREVIOUS`, deploy the new API secret, wait longer than the
maximum proxy TTL, and then remove the previous secret.

---

## 🗂️ Project Structure

```
src/
├── proxy.ts              # CORS & proxy middleware (Next.js 16)
├── app/
│   ├── page.tsx          # Swagger UI documentation page
│   ├── layout.tsx        # Root layout
│   └── api/              # API route handlers
│       ├── home/         # GET /api/home
│       ├── search/       # GET /api/search
│       ├── filter/       # GET /api/filter
│       ├── anime/        # GET /api/anime/:slug (+ /episodes)
│       │   └── tooltip/  # GET /api/anime/tooltip/:id
│       ├── updated/      # GET /api/updated
│       ├── status/       # GET /api/status
│       ├── genre/        # GET /api/genre/:genre
│       ├── type/         # GET /api/type/:type
│       ├── schedule/     # GET /api/schedule
│       ├── watch/        # GET /api/watch/:slug
│       └── proxy/        # GET /api/proxy
├── lib/
│   ├── types.ts          # TypeScript interfaces
│   ├── constants.ts      # Base URL, cache TTLs, filter options
│   ├── cache.ts          # Node-Cache instance
│   ├── fetcher.ts        # Axios-based HTML fetcher
│   ├── extractors.ts     # Cheerio extraction helpers
│   └── scrapers/         # Per-endpoint scraping logic
│       ├── anime.scraper.ts
│       ├── home.scraper.ts
│       ├── schedule.scraper.ts
│       ├── search.scraper.ts
│       ├── tooltip.scraper.ts
│       └── watch.scraper.ts
public/
└── openapi.yaml          # OpenAPI 3.0 specification
```

---

## 🛠️ Tech Stack

- [Next.js 16](https://nextjs.org) — App Router
- [Cheerio](https://cheerio.js.org) — server-side HTML parsing
- [Axios](https://axios-http.com) — HTTP client
- [Node-Cache](https://www.npmjs.com/package/node-cache) — in-memory caching
- [Swagger UI](https://swagger.io/tools/swagger-ui/) — interactive API docs

---

## 👤 Author

**Teramoto** · [github.com/Teramoto669](https://github.com/Teramoto669)
