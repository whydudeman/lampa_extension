import re, sys, os, posixpath, urllib.request
base, page, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36"
def get(u):
    try:
        return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=20).read().decode("utf-8", "replace")
    except Exception as e:
        print("ERR", u, e); return ""
html = open(page).read()
queue = set(re.findall(r'/_app/immutable/[^"\']+\.js', html)); seen = set()
while queue:
    p = queue.pop()
    if p in seen: continue
    seen.add(p)
    src = get(base + p)
    open(os.path.join(outdir, p.strip('/').replace('/', '__')), "w").write(src)
    for r in re.findall(r'["\'](\.\.?/[A-Za-z0-9_./-]+\.js)["\']', src):
        queue.add(posixpath.normpath(posixpath.join(posixpath.dirname(p), r)))
print(len(seen), "files")
