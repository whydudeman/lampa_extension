import json, sys, urllib.request, urllib.parse
UA = "Mozilla/5.0 (Linux; Tizen 6.0) AppleWebKit/537.36 TV Safari/537.36"
def get(u, rng=None):
    h = {"User-Agent": UA}
    if rng: h["Range"] = rng
    r = urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=40)
    return r.status, r.headers.get("content-type"), r.read()
for q in sys.argv[1:]:
    try:
        st, ct, b = get("https://api.vidlove.cc/" + q)
        d = json.loads(b); s = d.get("source") or {}
        man = s.get("manifest") or ""
        print("==", q, "|", s.get("source"), s.get("label"), "| codecs:", sorted(set(x.split('"')[1].split(',')[0][:4] for x in man.split("CODECS=")[1:])), "| subs:", [x.get("label") for x in d.get("subtitles", [])][:6])
        if not s.get("url"): continue
        st, ct, b = get(s["url"]); lines = [l for l in b.decode().splitlines() if l and not l.startswith("#")]
        print("   master", st, ct, "variants", len(lines))
        st, ct, b = get(urllib.parse.urljoin(s["url"], lines[-1])); seg = [l for l in b.decode().splitlines() if l and not l.startswith("#")]
        print("   variant", st, "segments", len(seg), seg[0][:60] if seg else '')
        if seg:
            st, ct, b = get(urllib.parse.urljoin(s["url"], seg[0]), "bytes=0-187"); print("   segment", st, ct, b[:8].hex())
    except Exception as e:
        print("==", q, "ERR", e)
