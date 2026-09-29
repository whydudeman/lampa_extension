import json, re, sys, urllib.request, urllib.parse, urllib.error
UA = "Mozilla/5.0 (Linux; Tizen 6.0) AppleWebKit/537.36 TV Safari/537.36"
def get(u, rng=None):
    h = {"User-Agent": UA}
    if rng: h["Range"] = rng
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=30); return r.status, r.headers.get("content-type"), r.read()
    except urllib.error.HTTPError as e:
        return e.code, None, e.read()
path = sys.argv[1]
st, _, b = get("https://vixsrc.to/api/" + path)
print("api", st, b[:80])
if st != 200: sys.exit()
src = json.loads(b)["src"]
st, _, html = get("https://vixsrc.to" + src); html = html.decode()
streams = json.loads(re.search(r"window\.streams\s*=\s*(\[.*?\]);?\n", html).group(1))
token = re.search(r"'token':\s*'([^']+)'", html).group(1)
expires = re.search(r"'expires':\s*'([^']+)'", html).group(1)
fhd = "window.canPlayFHD = true" in html
print("streams", [s["name"] for s in streams], "fhd", fhd)
for s in streams:
    u = s["url"]
    master = u + ("&" if "?" in u else "?") + "token=" + token + "&expires=" + expires + ("&h=1" if fhd else "") + "&lang=en"
    st, ct, b = get(master)
    text = b.decode("utf-8", "replace")
    print(" ", s["name"], "master", st, ct, "variants", text.count("#EXT-X-STREAM-INF"), "audio", re.findall(r'LANGUAGE="(\w+)"', text)[:6], "subs", text.count("TYPE=SUBTITLES"))
    if st != 200: continue
    variant = urllib.parse.urljoin(master, [l for l in text.splitlines() if l and not l.startswith("#")][0])
    st, ct, b = get(variant); vt = b.decode("utf-8", "replace")
    key = re.search(r'#EXT-X-KEY:([^\n]+)', vt)
    seg = urllib.parse.urljoin(variant, [l for l in vt.splitlines() if l and not l.startswith("#")][0])
    st2, ct2, sb = get(seg, "bytes=0-187")
    print("    variant", st, "key", key.group(1)[:60] if key else None, "| segment", st2, ct2, sb[:4].hex())
