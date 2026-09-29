import json, sys, urllib.request, urllib.parse
UA = "Mozilla/5.0 (Linux; Tizen 6.0) AppleWebKit/537.36 TV Safari/537.36"
def get(u, rng=None):
    h = {"User-Agent": UA}
    if rng: h["Range"] = rng
    r = urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=30)
    return r.status, r.headers.get("content-type"), r.read()
path = sys.argv[1]
st, ct, body = get("https://embed.vidrift.net/api/boot/" + path)
meta = json.loads(body)["meta"]
print("boot", st, "warm", len(meta.get("warmStreams") or []), "orion", len(meta.get("orionStreams") or []), "season", meta.get("season"), "ep", meta.get("episode"))
for s in (meta.get("warmStreams") or [])[:1]:
    master = s["proxyUrl"] or s["url"]
    st, ct, b = get(master); print("master", st, ct)
    variant = urllib.parse.urljoin(master, [l for l in b.decode().splitlines() if l and not l.startswith("#")][0])
    st, ct, b = get(variant); print("variant", st, ct)
    seg = urllib.parse.urljoin(variant, [l for l in b.decode().splitlines() if l and not l.startswith("#")][0])
    st, ct, b = get(seg, "bytes=0-187"); print("segment", st, ct, b[:8].hex(), "TS" if b[:1] == b"\x47" else "")
