import json,subprocess,concurrent.futures,time,pathlib,tempfile,os
OUT=pathlib.Path(os.environ.get('LAMPA_AUDIT_DIR', str(pathlib.Path(tempfile.gettempdir()) / 'lampa-tv-audit'))); OUT.mkdir(exist_ok=True)
TARGETS={
'Cinejoy':'https://cinejoy.pk','Cinejoy servers':'https://api.wing.st/servers','Cinejoy subtitles':'https://subs.wing.st/subtitles?type=movie&tmdb=550',
'VidRift':'https://embed.vidrift.net/api/boot/movie/550?type=movie&id=550&source=0&provider=&shell=1','VixSrc':'https://vixsrc.to/api/movie/550','VidLove':'https://api.vidlove.cc/movie?id=550&mode=json&hevc=0',
'Movy':'https://movy.sx','Flixer':'https://flixer.gd','Hexa':'https://hexa.su','VidRock':'https://vidrock.net/api/movie/550','VidNest':'https://new.vidnest.fun/yflix/movie/550','CineSrc':'https://cinesrc.st','VidZee':'https://core.vidzee.wtf/streams/movie/550?s=dcloud','xpass':'https://play.xpass.top/data/movie/550','moviesapi':'https://moviesapi.to/api/vidora/v1/movie/550','PrimeSrc':'https://primesrc.me/api/v1/s?tmdb=550&type=movie','PopcornMovies':'https://popcornmovies.ac','BingeBox':'https://bingebox.ac',
'vidlink':'https://vidlink.pro/movie/550','videasy':'https://player.videasy.net/movie/550','vidfast.pro':'https://vidfast.pro/movie/550','vidfast.vc':'https://vidfast.vc/movie/550','111movies':'https://111movies.net/movie/550','vidsrc.to':'https://vidsrc.to/embed/movie/550','vidsrc.mov':'https://vidsrc.mov/embed/movie/550','2embed':'https://2embed.cc/embed/550','vsembed':'https://vsembed.ru/embed/movie/550','vidstorm':'https://vidstorm.ru/embed/movie/550','cinemaos':'https://cinemaos.tech','filmu':'https://embed.filmu.in','vidora':'https://vidora.su','Rive':'https://www.rivestream.app','vidsync':'https://vidsync.xyz','vidsuper':'https://vidsuper.net','1embed':'https://1embed.cc','vidking':'https://www.vidking.net','zxcstream':'https://zxcstream.xyz'}
def probe(item):
 name,url,mode,repeat=item; key=name.replace('.','_').replace(' ','_')+'_'+mode+'_'+str(repeat)
 args=['curl','-sS','-L','--max-time','25','--max-filesize','3000000','-D',str(OUT/(key+'.headers')),'-o',str(OUT/(key+'.body')),'-w','%{http_code}\t%{time_total}\t%{url_effective}',url]
 if mode=='lampa': args[1:1]=['-H','Origin: https://lampa.mx']
 p=subprocess.run(args,capture_output=True,text=True); v=p.stdout.split('\t'); h=(OUT/(key+'.headers')).read_text(errors='replace') if (OUT/(key+'.headers')).exists() else ''; b=(OUT/(key+'.body')).read_text(errors='replace') if (OUT/(key+'.body')).exists() else ''
 return dict(name=name,url=url,mode=mode,repeat=repeat,status=v[0] if v else '',seconds=v[1] if len(v)>1 else '',final=v[2] if len(v)>2 else '',error=p.stderr[:250],cors=[l for l in h.splitlines() if l.lower().startswith('access-control-allow-origin:')],kind='json' if b.lstrip().startswith(('{','[')) else 'hls' if b.startswith('#EXTM3U') else 'html' if '<html' in b.lower() else 'other',encrypted='"encrypted":true' in b.replace(' ',''),challenge='cf-chl-' in b or 'Just a moment' in b,bytes=len(b))
jobs=[(n,u,m,r) for r in [1,2] for n,u in TARGETS.items() for m in ['direct','lampa']]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 rows=list(pool.map(probe,jobs))
(OUT/'survey.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows,indent=1))
