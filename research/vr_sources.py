import json, sys, urllib.request, urllib.parse, urllib.error, time
UA = "Mozilla/5.0 (Linux; Tizen 6.0) AppleWebKit/537.36 TV Safari/537.36"
H = {}
def get(u, extra=None):
    h = dict(H); h.update(extra or {})
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=60)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()
base = "https://embed.vidrift.net"
path = sys.argv[1]
for prov in sys.argv[2].split(","):
    st, b = get(f"{base}/api/boot/{path}")
    token = json.loads(b)["meta"]["playbackToken"]
    t0 = time.time()
    st, b = get(f"{base}/api/source/{path.split('?')[0]}?token={urllib.parse.quote(token)}&provider={prov}")
    try:
        d = json.loads(b)
    except Exception:
        print(f"{prov:9} {st} non-json {b[:60]!r}"); continue
    streams = d.get("streams") or []
    line = f"{prov:9} {st} {time.time()-t0:4.1f}s success={d.get('success')} streams={len(streams)} subs={len(d.get('subtitles') or [])} err={str(d.get('error',''))[:50]}"
    if streams:
        s = streams[0]; u = s.get("proxyUrl") or s.get("url")
        if u.startswith("/"): u = base + u
        st2, b2 = get(u)
        line += f" | first={s.get('type')} direct={s.get('direct')} play={st2} {b2[:7]!r}"
    print(line)
