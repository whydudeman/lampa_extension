# EN Online — Lampa plugin

Adds an **EN Online** button to the movie/series card in Lampa. Sources are pluggable providers; their domains come from `config/mirrors.json`, which is synced daily from [FMHY / video](https://fmhy.net/video).

## Layout

| Path | Purpose |
|---|---|
| `plugin/en_online.js` | The plugin itself (ES5, single file — load its URL in Lampa) |
| `config/mirrors.json` | Site → list of live mirror origins, generated |
| `scripts/sync-mirrors.mjs` | Parses FMHY markdown into `mirrors.json` |
| `.github/workflows/sync-mirrors.yml` | Runs the sync daily and commits changes |
| `ref/online_mod.js` | Reference copy of nb557's online_mod (Lampa API patterns) |

## Install

1. Push the repo to GitHub, enable Pages (or use raw URLs).
2. Replace `USER` in `DEFAULT_MIRRORS_URL` inside `plugin/en_online.js`, or set the URL in Lampa → Settings → EN Online.
3. Lampa → Settings → Extensions → add `https://USER.github.io/lampa_extension/plugin/en_online.js`.

## Manual mirror sync

```bash
node scripts/sync-mirrors.mjs
```

## Provider contract

A provider is registered from any script loaded after the plugin:

```js
EnOnline.registerProvider({
  name: 'example',
  title: 'Example',
  site: 'examplesite',
  hosts: ['https://fallback.example'],
  probePath: '/',
  resolve: function (context, onStreams, onError) {
    var request = context.request;
    context.network.silent(context.withProxy(context.host + '/api/' + request.type + '/' + request.tmdbId), function (json) {
      onStreams([{ label: 'Server 1', url: json.m3u8, qualities: false, subtitles: false }]);
    }, function () { onError('request failed'); });
  }
});
```

- `site` is the key in `mirrors.json` (lowercased name, non-alphanumerics stripped: `PopcornMovies` → `popcornmovies`). The plugin tries every mirror of that site plus `hosts`, caches the first alive one for an hour.
- `context.request`: `tmdbId`, `imdbId`, `type` (`movie`/`tv`), `title`, `originalTitle`, `year`, `season`, `episode`.
- Stream: `label`, `url`, optional `info`, `qualities` (`{"1080p": url, ...}`), `subtitles` (`[{label, url}]`).

## Proxy

Many sources require a `Referer`/`Origin` header on HLS segments or don't send CORS headers. Set **CORS/Referer proxy** in settings — it is prepended to provider URLs (`https://proxy/` + `https://target/...`).

## Bundled providers

| Provider | API | Result | Notes |
|---|---|---|---|
| **VidRift** | `embed.vidrift.net/api/boot/{movie/ID \| tv/ID/S/E}` | Stable | Plain JSON, CORS `*`, HLS via `relay.vidrift.net` without Referer, VTT subtitles in many languages incl. Russian. Found through 7Movies. |
| **VidLove (beta)** | `api.vidlove.cc/{movie?id= \| tv?id=&season=&episode=}&mode=json&hevc=0` | ~50% of attempts | Plain JSON. Their `whysosigmabro.cfd` proxy often answers 503; provider retries up to 3 times. Found through 67Movies. Needs a browser User-Agent. |

## FMHY starred sites — survey (2026-09-30)

| Site | Backend | Usable |
|---|---|---|
| Cinejoy | `api.wing.st/g`, request/response encrypted with WASM (ECDH + AES-GCM) | No — deliberate anti-scraping |
| Movy | `api.wecollege.net/{server}/sources?...&enc=2`, encrypted response | No — deliberate anti-scraping |
| PopcornMovies / BingeBox | Cloudflare challenge on the site | No — unreachable from Lampa |
| 7Movies | embeds VidRift | Yes → VidRift |
| Flixer | `plsdontscrapemelove.flixer.gd`, WASM-decoded sources | No — deliberate anti-scraping |
| Rive | closes the inspection browser on load | Not checked |
| 67Movies | embeds VidLove | Yes → VidLove |

Rule of thumb for adding more: open the site, find which embed player it uses, and check whether that player's API returns stream URLs as plain JSON. Skip anything that encrypts the payload.
