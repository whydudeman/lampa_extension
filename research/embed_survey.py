import json, re, sys, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36"
def get(u):
    try:
        return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=15).read(3_000_000).decode("utf-8", "replace")
    except Exception:
        return ""
sites = json.load(open("../config/mirrors.json"))["sites"]
targets = [(k, v["hosts"][0]) for k, v in sites.items() if v["section"] in ("Multi-Server", "Dedicated-Server", "P-Stream Forks")]
TEMPLATE = re.compile(r'https?://([a-z0-9.-]+\.[a-z]{2,})(/[^"\'`\s<>]{0,60}?(?:embed|movie|tv|player|source)[^"\'`\s<>]{0,60})', re.I)
SKIP = re.compile(r'themoviedb|tmdb\.org|google|youtube|github|reddit|discord|twitter|x\.com|facebook|cloudflare|jsdelivr|unpkg|w3\.org|schema\.org|imdb|fonts|wikipedia|trakt|letterboxd|apple\.com|t\.me|instagram|tiktok|ko-fi|patreon|opensubtitles|anilist|myanimelist|kitsu|simkl')
def scan(item):
    key, host = item
    html = get(host)
    if not html: return key, host, None
    scripts = [urllib.parse.urljoin(host, s) for s in re.findall(r'<script[^>]+src="([^"]+)"', html)]
    scripts = [s for s in scripts if urllib.parse.urlparse(s).netloc == urllib.parse.urlparse(host).netloc][:25]
    text = html + "".join(get(s) for s in scripts)
    found = defaultdict(set)
    own = urllib.parse.urlparse(host).netloc.replace("www.", "")
    for dom, path in TEMPLATE.findall(text):
        if SKIP.search(dom) or own in dom: continue
        found[dom.lower()].add(path[:70])
    return key, host, found
res = list(ThreadPoolExecutor(16).map(scan, targets))
by_domain = defaultdict(set)
examples = {}
for key, host, found in res:
    if found is None: print("unreachable:", key); continue
    for dom, paths in found.items():
        by_domain[dom].add(key); examples.setdefault(dom, sorted(paths)[:2])
json.dump({d: sorted(s) for d, s in by_domain.items()}, open("embed_domains.json", "w"), indent=1)
for dom, keys in sorted(by_domain.items(), key=lambda x: -len(x[1]))[:45]:
    print(f"{len(keys):3} {dom:35} {examples[dom]}")
