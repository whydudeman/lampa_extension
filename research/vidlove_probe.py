import json, sys, urllib.request, urllib.error
UA = "Mozilla/5.0 (Linux; Tizen 6.0) AppleWebKit/537.36 TV Safari/537.36"
def head(u, referer=None):
    h = {"User-Agent": UA, "Range": "bytes=0-15"}
    if referer: h["Referer"] = referer
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=40)
        b = r.read(16); return f"{r.status} {r.headers.get('content-type')} {b[:10]!r}"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    except Exception as e:
        return f"ERR {e}"
for attempt in range(int(sys.argv[2])):
    try:
        d = json.loads(urllib.request.urlopen(urllib.request.Request("https://api.vidlove.cc/" + sys.argv[1], headers={"User-Agent": UA}), timeout=60).read())
    except Exception as e:
        print("api ERR", e); continue
    s = d.get("source") or {}
    quals = s.get("qualities") or []
    target = quals[0]["url"] if quals else s.get("url")
    print(f"#{attempt} source={s.get('source')} qualities={[(q.get('quality'), q.get('codec')) for q in quals]} manifest={'yes' if s.get('manifest') else 'no'}")
    if target:
        print("   no-referer :", head(target))
        print("   referer    :", head(target, "https://player.vidlove.cc/"))
