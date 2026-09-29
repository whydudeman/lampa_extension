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

| Provider | API | TV | Browser (lampa.mx) | Notes |
|---|---|---|---|---|
| **VidRift** | `embed.vidrift.net/api/boot/...`, fallback `/api/source/...?provider=vaplayer` | Works | 403 on stream (Origin) | Plain JSON, CORS `*`. Many subtitle languages incl. Russian. |
| **VixSrc** | `vixsrc.to/api/{movie/ID \| tv/ID/S/E}` → embed page (`window.streams`, token, expires) | Expected to work | No CORS on API/embed page | Standard HLS AES-128, English audio by default (`lang=en`), subtitles inside the stream. 480p/720p H.264. |

Test rule: a source is kept if the whole chain works from a script that sends **no** Origin/Referer — that is what a TV player does.

## Survey results (2026-09-30)

| Player / site | Result |
|---|---|
| VidRift (via 7Movies) | ✅ added |
| VixSrc (via many Multi-Server sites) | ✅ added |
| VidLove (via 67Movies) | ❌ API forbids foreign Origin; stream proxy often 503 — failed on TV |
| Cinejoy, Movy, Flixer, VidRock, VidNest, CineSrc | ❌ encrypted payloads / crypto challenge |
| VidZee, xpass, moviesapi | ❌ 403 without their own Referer (would fail on TV too) |
| PrimeSrc | ❌ only file-host keys (Filemoon/Voe) behind obfuscated pages |
| PopcornMovies | ❌ Cloudflare challenge |
| vidsync, vidsuper, 1embed, vidking, zxcstream | ❌ down or not reachable |

Rule of thumb for adding more: open the site, find which embed player it uses, and check whether that player's API returns stream URLs as plain JSON. Skip anything that encrypts the payload.
