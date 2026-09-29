(function(){
  // Sandbox guard: an iframe with sandbox="allow-scripts" and no
  // allow-same-origin runs us in an opaque, unique-per-load origin. Our JS
  // still executes (so a naive check would look fine), but that's exactly
  // the trick used to embed a player while stripping the origin identity
  // storage/session security depends on. Storage APIs throw a SecurityError
  // on an opaque origin — a reliable, spec-defined signal — so refuse to
  // initialize rather than run degraded and silently insecure.
  try {
    localStorage.setItem('__vidrift_sbx', '1');
    localStorage.removeItem('__vidrift_sbx');
  } catch (e) {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:100vh;color:#fff;background:#000;font:14px/1.4 system-ui,sans-serif;text-align:center;padding:20px;box-sizing:border-box;">This player cannot run in a sandboxed frame.</div>';
    return;
  }
  // Not out yet (server checked TMDB): say when, instead of walking every
  // source into a generic error. No telemetry -- this is not a playback failure.
  if(embedMeta.unreleased){
    var ur=document.getElementById('fatal'),urWhen='';
    try{urWhen=new Date(embedMeta.unreleased+'T00:00:00Z').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});}catch(e){urWhen=embedMeta.unreleased;}
    ['loader','preroll'].forEach(function(id){var el=document.getElementById(id);if(el)el.style.display='none';});
    ur.querySelector('h2').textContent='Not out yet';
    ur.querySelector('#fatalDetail').textContent=(embedMeta.type==='tv'?'S'+embedMeta.season+' · E'+embedMeta.episode+' airs ':'Releases ')+urWhen+'. Check back then.';
    var urActions=ur.querySelector('.fatal-actions');if(urActions)urActions.style.display='none';
    var urDiscord=ur.querySelector('.fatal-discord');if(urDiscord&&urDiscord.lastChild)urDiscord.lastChild.textContent="Get notified when it's out · Join our Discord";
    var urIcon=ur.querySelector('.fatal-icon');if(urIcon)urIcon.innerHTML='<svg viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM7 12h5v5H7z"/></svg>';
    ur.classList.add('show');
    try{window.parent.postMessage({type:'vidrift:unreleased',tmdbId:embedMeta.tmdbId,mediaType:embedMeta.type,season:embedMeta.season,episode:embedMeta.episode,airDate:embedMeta.unreleased},'*');}catch(e){}
    return;
  }
  var player=document.getElementById('player'),video=document.getElementById('video'),loader=document.getElementById('loader'),loaderStatus=document.getElementById('loaderStatus');
  var flash=document.getElementById('flash'),captionO=document.getElementById('captionOverlay');
  var introSkip=document.getElementById('introSkip'),introSegments=[],introSkipped=false;
  // Embedder preferences (7Movies Settings > Playback): autonext=0 stops the Up next countdown
  // from starting the next episode on its own; autoskip=1 jumps past known intros/recaps.
  // Absent = today's behaviour for every other site that embeds the player.
  var embedPrefs=window.__vidriftParams||new URLSearchParams(location.search),autoNext=embedPrefs.get('autonext')!=='0',autoSkipIntro=embedPrefs.get('autoskip')==='1';
  var nextUpCard=document.getElementById('nextUpCard'),nextUpTitle=document.getElementById('nextUpTitle'),nextUpCountdown=document.getElementById('nextUpCountdown'),nextUpTimer=null,nextUpCancelled=false,nextEpisodeInfo=null;
  var progressFill=document.getElementById('progressFill'),progressHandle=document.getElementById('progressHandle');
  var bufferedFill=document.getElementById('bufferedFill'),timeLabel=document.getElementById('timeLabel');
  var serverBtn=document.getElementById('serverBtn'),serverPanel=document.getElementById('serverPanel');
  var subtitlesBtn=document.getElementById('subtitlesBtn'),subtitlesPanel=document.getElementById('subtitlesPanel');
  var subtitleLanguages=document.getElementById('subtitleLanguages'),subtitleAppearance=document.getElementById('subtitleAppearance'),subtitleLangList=document.getElementById('subtitleLangList');
  var settingsBtn=document.getElementById('settingsBtn'),settingsPanel=document.getElementById('settingsPanel'),qualityOptions=null,audioOptions=null,qualityPreference='Auto';
  var castBtn=document.getElementById('castBtn');
  var allPanels=[serverPanel,subtitlesPanel,settingsPanel];
  var hideTimer=null,isScrubbing=false,hls=null,currentSub='off',streamReady=false,lastProgressSent=0,pendingResume=0,preservePaused=false,attemptedSources={},sourceSwitching=false,loadGeneration=0,startupTimer=null,presetSrcConsumed=false;

  var streams = [];
  var currentSource = Number(embedMeta.source) || 0;
  var currentProvider = embedMeta.provider || 'vaplayer';
  // Only providers with current production successes stay in the viewer path.
  // cinepro added 2026-09-09: relayed like vaplayer (its .site segments are
  // hotlink-locked, see the stream map), but resolves in 0.2-0.5s vs Earth's
  // ~6.7s and covers TV. Placed after vaplayer as a pure additive fallback;
  // move it ahead of vaplayer once its production success rate is measured.
  // Order must match SOURCE_CASCADE. Orion (moviebox) leads since 2026-09-25 by
  // the owner's call: it is the only lane with dubs (Hindi, Tamil, Telugu...)
  // and 1080p, played viewer-direct from CloudFront. It is HEVC-only, so a
  // device without an HEVC decoder never sees it and starts at Earth as before.
  var hevcOk=(function(){var c='video/mp4; codecs="hvc1.1.6.L93.90"';try{return !!(document.createElement('video').canPlayType(c)||(window.MediaSource&&MediaSource.isTypeSupported&&MediaSource.isTypeSupported(c)));}catch(e){return false;}})();
  var providers = ['moviebox', 'vaplayer', 'vidlove', 'vidrock'];
  if(!hevcOk){providers.shift();if(embedMeta.provider==='moviebox')embedMeta.provider='';}
  // Direct (the box) is the LAST fallback by the owner's call (2026-09-18): the
  // scrapers get every title first, our own copy only when they all fail. The
  // server seeds it to the front only via coverageHint, i.e. when the probe
  // already saw every scraper fail for this exact title.
  if (embedMeta.selfhostUrl) providers.push('selfhost');
  // Evion (our partners' library, H.264, dubs inside one playlist) leads whenever the page baked its URL.
  if (embedMeta.evionUrl) providers.unshift('evion');
  // An explicit ?provider= that is NOT part of the cascade has to LEAD the array, not just seed currentProvider:
  // loadProviderAt() reassigns currentProvider=providers[index], which silently
  // discarded the opt-in and ran the normal cascade instead. Normal fallback
  // still continues behind it, and the default cascade is unchanged for everyone
  // who does not ask for a specific provider.
  if(embedMeta.provider && ["saturn","mars","vidlink","vidking","movienight","turbo","vidgod","cinepro","flax"].indexOf(embedMeta.provider)===-1 && providers.indexOf(embedMeta.provider)===-1) providers.unshift(embedMeta.provider);
  // A seeded provider that is already in the cascade moves to the FRONT rather
  // than being jumped to: loadProviderAt() walks forward from the start index,
  // so starting at index 2 would end the cascade after one provider. Rotating
  // keeps every fallback reachable when a hint turns out stale.
  if(embedMeta.provider && providers.indexOf(embedMeta.provider)>0){providers.splice(providers.indexOf(embedMeta.provider),1);providers.unshift(embedMeta.provider);}
  if(!embedMeta.provider)currentProvider=providers[0];
  var warmStreamsUsed=false,hlsWaits=0;
  // Stale tabs (2026-09-28): a page left open for hours still holds the stream list and
  // token it booted with. Baked lists are only trusted for an hour (Orion ids can be
  // evicted server-side), and an expired token is swapped for a fresh one once instead of
  // an error screen, because every source would 403 on it anyway.
  var pageBornAt=Date.now(),tokenRefreshTried=false;
  function tokenExpMs(t){try{return JSON.parse(atob(String(t).split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))).exp*1000||0;}catch(e){return 0;}}
  // In place, for the SAME parent: /api/boot mints a grant for a tokenless request (it sets
  // no cookie for those; the old session cookie had the token's own 12 h Max-Age, so it is
  // gone too and /api/source's cookie check passes). Not a reload: a reloaded iframe is its
  // own referrer, and embed.vidrift.net is not ad-free, so a 7movies viewer would get the ad.
  function refreshExpiredToken(){
    if(tokenRefreshTried)return Promise.resolve(false);
    tokenRefreshTried=true;
    return fetch('/api/boot/'+sourceTypePath(),{credentials:'include',headers:{'x-embed-parent':embedMeta.parent?'https://'+embedMeta.parent:''}})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(j){
        var t=j&&j.meta&&j.meta.playbackToken;
        if(!t||tokenExpMs(t)<=Date.now())return false;
        appliedPlaybackToken=embedMeta.playbackToken=t;
        if(video.currentTime>0)pendingResume=video.currentTime;
        return true;
      }).catch(function(){return false;});
  }
  var warmManifests=(embedMeta&&embedMeta.warmManifests)?embedMeta.warmManifests:null;
  // ---- Telemetry (2026-09-17) ----
  // Three events, one beacon each, nothing else: first_frame (ms from iframe
  // navigation to the first 'playing'), play_failed (every provider exhausted,
  // with the reason the fatal screen shows), and watch_abandon (the viewer
  // left: where they were, how long the title is, and whether a frame was
  // ever shown -- that last flag is the "gave up before it started" rate).
  // sendBeacon so the abandon event survives the page going away.
  var telemetrySent={};
  // hevcOk (computed with the provider list) rides on every event: it sizes Orion's audience.
  function sendTelemetry(event,data){
    try{
      var body=JSON.stringify(Object.assign({event:event,tmdbId:embedMeta.tmdbId,type:embedMeta.type,season:embedMeta.season||null,episode:embedMeta.episode||null,provider:currentProvider,parent:embedMeta.parent||'',hevc:hevcOk?1:0,t:Math.round(performance.now())},data||{}));
      if(navigator.sendBeacon)navigator.sendBeacon('/api/telemetry',new Blob([body],{type:'application/json'}));
      else fetch('/api/telemetry',{method:'POST',body:body,headers:{'Content-Type':'application/json'},keepalive:true}).catch(function(){});
    }catch(e){}
  }
  // Rebuffering after the first frame (seeks excluded), so buffering can be compared
  // per source (2026-09-25: Orion lost ~7 pts more viewers in the first 30 s than
  // Earth and nothing said whether that was stalls or black-screen HEVC decode).
  var stallCount=0,stallMs=0,stallAt=0;
  video.addEventListener('waiting',function(){if(telemetrySent.first&&!video.seeking&&!stallAt)stallAt=Date.now();});
  video.addEventListener('playing',function(){if(stallAt){stallCount++;stallMs+=Date.now()-stallAt;stallAt=0;}});
  video.addEventListener('seeking',function(){stallAt=0;});
  function abandonOnce(){
    if(telemetrySent.abandon)return;telemetrySent.abandon=true;
    var q=null;try{q=video.getVideoPlaybackQuality&&video.getVideoPlaybackQuality();}catch(e){}
    var st=streams[currentSource];
    sendTelemetry('watch_abandon',{position:Math.round(video.currentTime||0),duration:Math.round(isFinite(video.duration)?video.duration:0),played:!!telemetrySent.first,
      stalls:stallCount+(stallAt?1:0),stallMs:stallMs+(stallAt?Date.now()-stallAt:0),frames:q?q.totalVideoFrames:-1,dropped:q?q.droppedVideoFrames:-1,h:video.videoHeight||0,src:st?String(st.label).slice(0,40):''});
  }
  window.addEventListener('pagehide',abandonOnce);
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')abandonOnce();});
  // Built lazily so Hls is guaranteed loaded (hls.min.js is deferred).
  function warmPLoader(){
    var Base=Hls.DefaultConfig.loader;
    function L(config){this.base=new Base(config);}
    // hls.js reads loader.stats and loader.context directly, and XhrLoader
    // replaces its stats object on EVERY load(). A copy taken at construction
    // goes stale after the first real fetch, so the manifest load never
    // registers as finished and MANIFEST_PARSED never fires -- which is how
    // every title WITHOUT inlined manifests stalled at "Loading video" on
    // 2026-09-17 while the inlined ones played fine. Expose the live objects.
    Object.defineProperty(L.prototype,'stats',{get:function(){return this.base.stats;},set:function(v){this.base.stats=v;}});
    Object.defineProperty(L.prototype,'context',{get:function(){return this.base.context;},set:function(v){this.base.context=v;}});
    L.prototype.destroy=function(){this.base.destroy();};
    L.prototype.abort=function(){this.base.abort();};
    L.prototype.load=function(context,config,callbacks){
      // Earth's bodies are keyed by absolute URL, Orion's by same-origin path (orionWarm).
      var key=context.url;
      if(warmManifests&&!warmManifests[key]&&key.indexOf(location.origin+'/')===0)key=key.slice(location.origin.length);
      var entry=warmManifests?warmManifests[key]:null;
      if(!entry)return this.base.load(context,config,callbacks);
      delete warmManifests[key];
      var base=this.base;
      // Same shape XhrLoader produces: a fresh LoadStats per load, on the base.
      var st=new (base.stats.constructor)();
      base.stats=st;base.context=context;
      // Orion's startup playlists arrive gzipped; if they cannot be inflated here -- or come out as
      // anything but a whole VOD playlist -- fetch as before. 2026-09-28: 2 levelParsingErrors on
      // inflated Orion playlists (one viewer, Lanterns S1E7) against 0 in 64k network-loaded plays.
      (typeof entry==='string'?Promise.resolve(entry):inflateB64(entry.gz).then(function(b){if(b.indexOf('#EXTM3U')!==0||b.indexOf('#EXT-X-ENDLIST')<0)throw new Error('partial');return b;})).then(function(body){
        setTimeout(function(){
          if(st.aborted)return;
          var now=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
          // 1ms rather than 0: a zero-duration load divides by zero in any bandwidth math.
          st.loading.start=now-1;st.loading.first=now-1;st.loading.end=now;
          st.loaded=st.total=body.length;st.aborted=false;
          try{callbacks.onSuccess({url:context.url,data:body},st,context,null);}
          catch(e){}
        },0);
      },function(){if(!st.aborted)base.load(context,config,callbacks);});
    };
    return L;
  }
  function inflateB64(b64){try{var bin=atob(b64),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).text();}catch(e){return Promise.reject(e);}}
  var subtitleOffsetKey='vidrift:subtitle-offset:'+embedMeta.tmdbId+':'+(embedMeta.season||'movie')+':'+(embedMeta.episode||'');
  var subtitleOffset=parseFloat(localStorage.getItem(subtitleOffsetKey)||'0')||0;
  var subtitleStyleKey='vidrift:subtitle-style',subtitleStyle={size:'100',color:'#ffffff',background:'box',font:'inter',position:'0'};
  try{subtitleStyle=Object.assign(subtitleStyle,JSON.parse(localStorage.getItem(subtitleStyleKey)||'{}'));}catch(e){}
  var subtitleElements={},nativeSubtitleElements={},isNativeFullscreen=false,isIOSNativeVideo=!!video.webkitEnterFullscreen;
  // iOS Safari only renders native <track> captions when the tracks exist before the
  // video loads metadata — late-created tracks are ignored by the fullscreen player.
  // Create all languages up-front (hidden); syncNativeSubtitle switches the selected
  // one to 'showing' for iPhone's native fullscreen surface.
  try{
    subtitleTracks.forEach(function(item){
      var t=document.createElement('track');
      // src is set lazily in loadSubtitle — the element only has to EXIST before
      // the video loads metadata for iOS fullscreen captions to work; giving it
      // a src here made the browser fetch all 10 languages on mount.
      t.kind='subtitles';t.label=item.label;t.srclang=item.lang||item.code;
      t.track.mode='hidden';
      video.appendChild(t);
      nativeSubtitleElements[item.code]=t;
    });
  }catch(e){}
  var srcMemKey='vidrift:src:'+embedMeta.tmdbId+':'+(embedMeta.type==='tv'?'tv':'movie')+':'+currentProvider;
  function rememberSource(idx){try{var s=streams[idx]||{};localStorage.setItem('vidrift:src:'+embedMeta.tmdbId+':'+(embedMeta.type==='tv'?'tv':'movie')+':'+(s.provider||currentProvider),String(s.pIdx!=null?s.pIdx:idx));}catch(e){}try{var s2=streams[idx]||{};fetch('/api/source/report?tmdbId='+embedMeta.tmdbId+'&type='+embedMeta.type+'&provider='+encodeURIComponent(s2.provider||currentProvider)+'&index='+(s2.pIdx!=null?s2.pIdx:idx)+'&ok=1',{method:'GET'}).catch(function(){});}catch(e){}}
  // Orion: the dub a viewer picks by hand (Hindi, Tamil...) is remembered across
  // titles. Only manual picks count, never a failover, so an English viewer is
  // not moved to a dub because the Original once failed.
  function pickSource(idx){
    if(idx===currentSource)return;
    var s=streams[idx];
    if(s&&s.provider==='moviebox'&&s.label){try{localStorage.setItem('vidrift:orion:dub',s.label.split(' · ')[1]||'');}catch(e){}}
    // Mid-playback, a manual switch (another dub, another server) keeps the
    // position and play/pause state and shows only the spinner, like failover
    // does. It used to restart the title with the full startup screen.
    if(!streamReady){loadStream(idx,false);return;}
    pendingResume=video.currentTime||0;preservePaused=video.paused;
    setLoaderStatus('Switching to '+(s?s.label:'source')+'…');player.classList.add('loading');loader.classList.add('show');
    loadStream(idx,true);
  }
  function orionDubIndex(){try{var d=localStorage.getItem('vidrift:orion:dub');if(!d)return -1;for(var i=0;i<streams.length;i++)if(streams[i].label.split(' · ')[1]===d)return i;}catch(e){}return -1;}
  function preferredSource(streamsLen){try{var v=parseInt(localStorage.getItem(srcMemKey)||'',10);if(isFinite(v)&&v>=0&&v<streamsLen)return v;}catch(e){}return -1;}

  // Feature-length titles were reading "134:22" — roll into h:mm:ss past an hour.
  function fmt(t){if(!isFinite(t)||t<0)return'0:00';var h=Math.floor(t/3600);var m=Math.floor(t/60)%60;var s=Math.floor(t%60).toString().padStart(2,'0');return h?h+':'+m.toString().padStart(2,'0')+':'+s:m+':'+s;}
  function showFlash(p){flash.innerHTML='<svg viewBox="0 0 24 24">'+p+'</svg>';flash.classList.remove('show');void flash.offsetWidth;flash.classList.add('show');}
  function setLoaderStatus(text){loaderStatus.textContent=text;}
  function loadIntroDb(){var q=new URLSearchParams({tmdb_id:String(embedMeta.tmdbId),duration_ms:String(Math.round(video.duration*1000))});if(embedMeta.type==='tv'){q.set('season',String(embedMeta.season||1));q.set('episode',String(embedMeta.episode||1));}fetch('https://api.theintrodb.org/v3/media?'+q.toString()).then(function(r){return r.ok?r.json():null;}).then(function(data){introSegments=[].concat(data&&data.intro||[],data&&data.recap||[]);}).catch(function(){});}
  function updateIntroSkip(){var t=video.currentTime*1000;if(autoSkipIntro){var auto=introSegments.find(function(item){return !item.autoSkipped&&t>=(item.start_ms||0)&&item.end_ms&&t<item.end_ms-1000;});if(auto){auto.autoSkipped=true;video.currentTime=auto.end_ms/1000;introSkip.classList.remove('show');return;}}var segment=introSegments.find(function(item){return !introSkipped&&t>=(item.start_ms||0)&&item.end_ms&&t<item.end_ms;});if(segment){introSkip.textContent=(segment===introSegments[0]?'Skip intro':'Skip recap');introSkip.classList.add('show');introSkip.onclick=function(){video.currentTime=segment.end_ms/1000;introSkipped=true;introSkip.classList.remove('show');};}else introSkip.classList.remove('show');}
  function hideNextUp(){clearInterval(nextUpTimer);nextUpTimer=null;nextUpCard.classList.remove('show');}
  function showNextUp(){if(embedMeta.type!=='tv'||nextUpCancelled||!nextEpisodeInfo)return;var left=5;nextUpTitle.textContent='S'+nextEpisodeInfo.season+' · E'+nextEpisodeInfo.episode;if(!autoNext){document.getElementById('nextUpHint').textContent='Autoplay is off';nextUpCard.classList.add('show');return;}nextUpCountdown.textContent=left;nextUpCard.classList.add('show');clearInterval(nextUpTimer);nextUpTimer=setInterval(function(){left-=1;nextUpCountdown.textContent=left;if(left<=0){hideNextUp();try{window.parent.postMessage({type:'vidrift:nextup-play',tmdbId:embedMeta.tmdbId,mediaType:embedMeta.type,season:embedMeta.season,episode:embedMeta.episode},'*');}catch(e){}}},1000);}
  document.getElementById('nextUpPlay').addEventListener('click',function(){hideNextUp();try{window.parent.postMessage({type:'vidrift:nextup-play',tmdbId:embedMeta.tmdbId,mediaType:embedMeta.type,season:embedMeta.season,episode:embedMeta.episode},'*');}catch(e){}});
  document.getElementById('nextUpCancel').addEventListener('click',function(){nextUpCancelled=true;hideNextUp();});

  var pStage=document.getElementById('prerollStage'),pStageWrap=document.getElementById('prerollStatusWrap'),pServer=document.getElementById('prerollServer'),pFill=document.getElementById('prerollFill'),pFoot=document.getElementById('prerollFoot'),pPct=document.getElementById('prerollPct'),prerollRig=document.getElementById('prerollRig');
  var prerollTimers=[],finishPreroll=null,prerollStates={},providerStates={},prerollProgress=0,prerollRetryPass=false;
  var prerollRAF=null,prerollStart=0,prerollFloor=0,prerollFinishFrom=-1,prerollFinishAt=0;
  var prerollReadyLabel='';
  var autoplayTimers=[];
  // Start with sound. Unmuted autoplay is only allowed where the browser
  // trusts this embed (Chrome media engagement, iframe allow=autoplay), so
  // every start attempt goes out unmuted FIRST and the rejection handler
  // falls back to muted for the rest of the session. It cannot be done the
  // other way round: a video that is already rolling muted gets paused by
  // Chrome if it unmutes without a user gesture.
  var wantSound=true;try{if(localStorage.getItem('vidrift:muted')==='1')wantSound=false;}catch(e){}
  // ?muted=1 starts muted for this load only; ?autoplay=0 takes the same
  // start-paused path a provider switch uses, so the first frame waits for a click.
  if(embedPrefs.get('muted')==='1')wantSound=false;
  if(embedPrefs.get('autoplay')==='0')preservePaused=true;
  function clearAutoplayRetries(){autoplayTimers.forEach(clearTimeout);autoplayTimers=[];}
  function applyMuteState(){if(wantSound){video.muted=false;video.removeAttribute('muted');}else{video.muted=true;video.setAttribute('muted','');}updateVolIcon();}
  function playPreferringSound(){
    if(video.ended)return;
    // The <video> tag carries autoplay+muted so a baked-in src starts before
    // this script runs; restart that muted playback with sound instead.
    if(wantSound&&video.muted&&!video.paused)video.pause();
    applyMuteState();
    var p=video.play();
    if(p&&p.catch)p.catch(function(){
      if(!wantSound)return;
      wantSound=false;applyMuteState();
      var q=video.play();if(q&&q.catch)q.catch(function(){});
    });
  }
  function ensureAutoplay(){
    clearAutoplayRetries();
    if(video.ended)return;
    if(!video.paused&&!(wantSound&&video.muted))return;
    video.autoplay=true;
    video.playsInline=true;video.setAttribute('playsinline','');video.setAttribute('webkit-playsinline','');
    // iOS WebKit requires the first play() attempt to happen synchronously
    // inside the media event; a timer-only first attempt can be rejected.
    playPreferringSound();
    // The preroll overlay/ad can still consume a later attempt, so retain
    // bounded retries without overriding an intentional user pause.
    [180,700,1600,3000].forEach(function(delay){autoplayTimers.push(setTimeout(function(){
      if(video.ended||!video.paused||video.readyState<2)return;
      playPreferringSound();
    },delay));});
  }
  function renderPrerollRail(active){
    var rail=document.getElementById('prerollRail');if(!rail)return;
    // Chips are PROVIDERS, not stream indexes. The streams list is often
    // length 1 (a single Direct mirror) while providers is always four, so
    // keying the rail off streams hid it in exactly the situation — one stuck
    // source —
    // where the viewer most needs a way out. Mirror-level choice stays in the
    // gear panel; auto-failover already walks mirrors on its own.
    var st=prerollStates[active];
    rail.innerHTML='<div class="preroll-rail-label">Servers</div>'+providers.map(function(p){
      var isActive=p===currentProvider;
      var state=isActive?(st==='failed'?'failed':st==='ready'?'ready':'probing'):(providerStates[p]==='failed'?'failed':'queued');
      var text=isActive?(st==='failed'?'Unavailable':st==='ready'?'Ready':'Testing'):(providerStates[p]==='failed'?'Unavailable':'Switch');
      return '<button type="button" class="preroll-node '+state+'" data-provider="'+p+'"'+(isActive?' aria-current="true"':'')+' aria-label="'+(isActive?providerLabel(p)+' — '+text:'Switch to '+providerLabel(p))+'"><span class="region">'+providerLabel(p)+'</span><span class="sub">'+text+'</span></button>';
    }).join('');
    updatePrerollServer(active);
  }
  // Labels are built internally (providerLabel + index), never from upstream
  // JSON, so they go into innerHTML unescaped like the server panel's already do.
  function updatePrerollServer(active){
    if(!pServer)return;
    var s=streams[active];
    // Mid-switch the streams list still holds the OLD provider's mirrors, so fall back
    // to the provider name rather than naming a server we already left.
    var name=(s&&s.provider===currentProvider)?s.label:providerLabel(currentProvider);
    pServer.innerHTML=name+(prerollStates[active]==='ready'?' <span class="ok-tag">Ready</span>':'');
  }
  // A manual switch has to feel like a fresh start — otherwise the bar sits at
  // the old floor (often 96%) and tapping appears to do nothing.
  function prerollRestart(){
    // Cancel-then-schedule rather than trusting the !prerollRAF guard: a frame
    // requested while the tab was hidden is still pending, and skipping the
    // reschedule on that basis is a freeze waiting to happen.
    if(prerollRAF)cancelAnimationFrame(prerollRAF);
    prerollStart=performance.now();prerollFloor=0;prerollFinishFrom=-1;prerollPaint(0);
    prerollRAF=requestAnimationFrame(prerollLoop);
  }
  // Delegated: the rail is rebuilt on every state change, so per-node
  // listeners would leak and die. Reuses the server panel's switch path.
  document.getElementById('prerollRail').addEventListener('click',function(e){
    var btn=e.target.closest('[data-provider]');if(!btn)return;
    if(btn.dataset.provider===currentProvider)return;
    prerollRestart();switchProvider(btn.dataset.provider);
  });
  // Quiet phase: nothing is drawn for the first 1.5s. Most warm starts reach
  // canplay inside that window now, so most viewers never see a preroll at
  // all -- dark, then the first frame. The card appears only past 1.5s, and
  // the server strip only after 8s more or on a real failure: internal state
  // ("Earth TESTING") is not something a viewer should be asked to manage
  // while things are working.
  function showPrerollCard(servers){
    var pr=document.getElementById('preroll');
    if(!pr.classList.contains('show-card')){pr.classList.add('show-card');pr.dataset.cardAt=String(Math.round(performance.now()));loadBackdrop(pr);}
    if(servers)pr.classList.add('show-servers');
    else if(!prerollServersTimer)prerollServersTimer=setTimeout(function(){pr.classList.add('show-servers');},8000);
  }
  // The title art is requested here and nowhere else: the card is the only
  // thing that wants it, and most starts never show the card.
  function loadBackdrop(pr){
    var u=pr.dataset.backdrop;if(!u||pr.querySelector('.preroll-poster'))return;
    var img=new Image();img.onload=function(){var d=document.createElement('div');d.className='preroll-poster';d.style.backgroundImage='url("'+u+'")';pr.querySelector('.preroll-bg').appendChild(d);setTimeout(function(){d.classList.add('in');},20);};img.src=u;
  }
  var prerollCardTimer=null,prerollServersTimer=null;
  function clearPrerollGates(){clearTimeout(prerollCardTimer);clearTimeout(prerollServersTimer);prerollCardTimer=null;prerollServersTimer=null;}
  function setPrerollState(index,state){prerollStates[index]=state;renderPrerollRail(currentSource);if(state==='failed')showPrerollCard(true);}
  // The bar used to paint an exponential approach to 96% and a percent that
  // was pure wall-clock -- it read "96%" on titles whose video was already
  // buffered, and "still working on it" on ones that had been ready for
  // seconds (seen 2026-09-17). Now the bar is an indeterminate shimmer (CSS)
  // and the percent element is hidden. These stay as no-ops so the callers
  // that nudge progress on real state changes keep working unchanged.
  // The hairline now fills on those same real state changes (--p), never on time.
  function prerollPaint(p){prerollProgress=p;document.getElementById('preroll').style.setProperty('--p',p+'%');}
  function prerollLoop(){prerollRAF=null;}
  // Stage hints nudge the floor up; they can never pull the bar backwards.
  function animatePrerollTo(p){if(p>prerollProgress)prerollPaint(p);}
  function setStage(t,p){var old=pStage;if(old){old.classList.remove('enter');old.classList.add('leave');setTimeout(function(){if(old.parentNode)old.remove();},460);}pStage=document.createElement('div');pStage.className='preroll-status enter';pStage.textContent=t;pStageWrap.appendChild(pStage);animatePrerollTo(p);}
  // The status lines say which source is playing. A provider switch loads with
  // skipLoader, so no preroll runs and finishPreroll is null by then: without
  // this the hidden overlay kept "Loading Star 1" and the subtitle kept the old
  // provider while the new one played (reported 2026-09-24).
  function markReady(fallback){
    var ready=streams[currentSource]?streams[currentSource].label:fallback;if(!ready)return;
    setStage('Ready',100);pFoot.textContent='Playing '+ready;
    var tSub=document.getElementById('titleSub');if(tSub)tSub.textContent='Streaming via '+ready;setPrerollState(currentSource,'ready');
  }
  function runPreroll(label){
    player.classList.add('is-prerolling');
    player.classList.remove('controls-visible');
    if(finishPreroll)finishPreroll();
    var shouldAutoplay=!preservePaused;
    var pr=document.getElementById('preroll');
    if(prerollRAF){cancelAnimationFrame(prerollRAF);prerollRAF=null;}
    // The one-shot automatic cascade retry calls back through here. Zeroing the
    // bar on that pass replays the entire preroll from 0% / "Initializing",
    // which reads as the player starting over -- the "preroll runs twice"
    // report -- and it wipes the "Sources busy" line set moments earlier.
    // On the retry keep the progress already earned and say what is happening.
    // prerollFloor is monotonic (animatePrerollTo only raises it), so the
    // stage ladder re-running cannot drag the bar backwards.
    var prerollRetrying=prerollRetryPass;prerollRetryPass=false;
    prerollFinishFrom=-1;
    if(!prerollRetrying){prerollProgress=0;prerollFloor=0;prerollStart=performance.now();}
    loader.classList.remove('show');pr.classList.remove('hide','connected','show-card','show-servers');prerollRig.classList.remove('connected');pServer.innerHTML='';clearPrerollGates();setPrerollState(currentSource,'probing');
    if(prerollRetrying){pFoot.textContent='Retrying every source once more';}
    else{pFoot.textContent='Initializing';}
    prerollReadyLabel='';
    setStage(prerollRetrying?'Last try across every source':'Preparing your stream',prerollRetrying?64:6);
    // No timer ladder: the status line changes only on real transitions
    // (source found, manifest parsed, buffering), never on the clock, and it
    // never narrates slowness. A retry means we were already slow, so the
    // card comes up at once instead of going quiet again.
    prerollTimers=[];
    if(prerollRetrying)showPrerollCard(false);
    // 2.2s: warm first frames land at 1.0-1.8s from India, so 1.5s put the
    // card on screen for a few hundred ms on the fast path -- a flash, worse
    // than either state. Measured 2026-09-17.
    else prerollCardTimer=setTimeout(function(){showPrerollCard(false);},2200);
    finishPreroll=function(){
      prerollTimers.forEach(clearTimeout);prerollTimers=[];
      markReady(prerollReadyLabel||label);pr.classList.add('connected');prerollRig.classList.add('connected');
      if(shouldAutoplay)ensureAutoplay();
      clearPrerollGates();
      // If the card was never shown there is nothing to resolve visually:
      // drop the overlay now. If it was, hold a beat so "Ready" is seen.
      setTimeout(function(){
        pr.classList.add('hide');
        player.classList.remove('is-prerolling');
        // showC() bails while the preroll is up, and 'playing' fires before this
        // hide lands, so re-run it now: on touch outside fullscreen the bar
        // must be on screen from the first frame (2026-09-19).
        showC();
      },(pr.classList.contains('show-card')&&performance.now()-Number(pr.dataset.cardAt||0)>900)?360:0);
      pr.dataset.finishAt=String(Math.round(performance.now()));
      finishPreroll=null;
    };
  }

  function failoverSource(reason,detail){
    if(sourceSwitching)return;
    try{fetch('/api/source/report?tmdbId='+embedMeta.tmdbId+'&type='+embedMeta.type+'&provider='+encodeURIComponent(currentProvider)+'&index='+currentSource+'&ok=0',{method:'GET'}).catch(function(){});}catch(e){}
    // Why each source died, and how far it got: first_frame/play_failed only say which
    // provider won or that all lost (2026-09-26: 11.5% of Earth-after-Orion plays took >30 s, cause unknown).
    var st=streams[currentSource];
    sendTelemetry('source_failed',{reason:String(reason||'other').slice(0,60),detail:String(detail||'').slice(0,80),src:st?String(st.label).slice(0,40):'',started:streamReady?1:0,kb:Math.round(srcBytes/1024),ms:Math.round(performance.now()-srcStartAt)});
    setPrerollState(currentSource,'failed');
    var next=-1;
    streams.forEach(function(stream,i){
      if(stream.provider===currentProvider&&!attemptedSources[i]&&(next<0||(stream.pIdx||0)<(streams[next].pIdx||0)))next=i;
    });
    // Orion's dubs share one session and CDN: when a stream never got a media byte the rest
    // would each burn another stall timer (3 dubs = 55 s) before Earth. Go straight to the next provider.
    if(currentProvider==='moviebox'&&!streamReady&&srcBytes===0)next=-1;
    if(next<0){loadNextProvider();return;}
    sourceSwitching=true;
    pendingResume=video.currentTime||pendingResume||0;
    preservePaused=streamReady&&video.paused;
    setLoaderStatus('Source unavailable — trying another Earth source…'.replace('Earth',providerLabel(currentProvider)));
    if(document.getElementById('preroll').classList.contains('hide')){player.classList.add('loading');loader.classList.add('show');}
    setStage('Trying '+streams[next].label,92);pFoot.textContent=(streams[currentSource]?streams[currentSource].label:'Source')+' failed — trying '+streams[next].label;
    loadStream(next,true,true);
    sourceSwitching=false;
  }

  var lastFailZeroBytes=false;
  // Media bytes (not playlists, not the init) received by the current stream, and when it started.
  var srcBytes=0,srcStartAt=0;
  function loadStream(idx, skipLoader, keepAttempts){
    // hls.min.js is deferred and the /embed2/ shell appends this script once /api/boot answers,
    // so this can run before Hls exists -- and a missing Hls reads as "no MSE" below, which sent
    // Orion to Chrome's native HLS (fails on HEVC in ~0.3 s, falls to Earth). A round trip used
    // to hide it; baked sources have none (2026-09-28). Wait <=3 s -- but not for Evion/Direct,
    // whose native path is real: forcing hls.js on Evion cost +0.4 s median and took its
    // failures from 3.8 to 6.8 per 100 plays (status-0 manifest/fragment loads), 11:10-12:30.
    if(streams[idx]&&streams[idx].type==='hls'&&!window.Hls&&hlsWaits<150&&currentProvider!=='evion'&&currentProvider!=='selfhost'){hlsWaits++;setTimeout(function(){loadStream(idx,skipLoader,keepAttempts);},20);return;}
    currentSource=idx;var s=streams[idx];if(!s)return;
    if(!keepAttempts){attemptedSources={};prerollStates={};}
    attemptedSources[idx]=true;
    clearInterval(startupTimer);
    var generation=++loadGeneration;
    srcBytes=0;srcStartAt=performance.now();
    if(hls){hls.destroy();hls=null;}
    streamReady=false;if(!skipLoader){setLoaderStatus('Connecting to '+s.label+'…');player.classList.add('loading');loader.classList.add('show');runPreroll(s.label);}
    // Route by STREAM TYPE, not provider identity: a provider can fall back to
    // Earth's HLS streams when it has none for a title — those must go through
    // hls.js, not the direct-src path (fixed 2026-08-06; previously a fallback
    // was labeled mp4, video.src choked on the m3u8 → CinemaOS jump).
    // Direct HLS on Apple devices: native <video> playback (video.src=m3u8) is
    // dramatically faster and more reliable than MSE/hls.js on iOS — no
    // source-buffer pipeline, plays inline, survives cellular/Low Power Mode.
    // canPlayType('application/vnd.apple.mpegurl') is NOT a reliable capability
    // check: stock Chrome returns the truthy "maybe" while having no native HLS
    // at all. Trusting it sent every selfhost HLS title down the video.src path
    // on Chrome, where the element accepts the manifest, reports
    // networkState=LOADING, fetches NOTHING, never fires an 'error' event, and hangs
    // behind the spinner until the 30s startup timer fails over to another
    // provider (verified on Chrome 151, 2026-08-31 — this is very likely why
    // the selfhost fast path only saw ~16% of playbacks). Use hls.js wherever
    // MSE works; keep native only for Apple, where it is real and better, or as
    // a last resort when MSE is unavailable.
    var appleNative = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
    var mseHls = !!(window.Hls && window.Hls.isSupported());
    // Orion (moviebox) is HEVC only. Without an HEVC decoder a direct MP4 plays
    // sound over a black frame instead of erroring, so skip it up front.
    if(currentProvider==='moviebox'&&!hevcOk){setTimeout(function(){if(generation===loadGeneration)failoverSource('no-hevc');},0);return;}
    var nativeHls = s.type==='hls' && !!video.canPlayType('application/vnd.apple.mpegurl') &&
      (((currentProvider==='selfhost'||currentProvider==='evion') && (appleNative || !mseHls)) || (currentProvider==='moviebox' && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || !mseHls)));
    // vidlove was always direct-played, from when its URLs returned MP4. With
    // its player referer it now returns a real HLS variant, and <video src> of a
    // playlist only works where HLS is native (iOS). On MSE browsers it errored
    // straight into the next provider -- vidlove was 16% of resolutions and 0%
    // of playbacks on 2026-09-17. So: direct only when HLS is native or the
    // stream is not HLS; otherwise the same hls.js path vaplayer uses.
    var directPlay = nativeHls || s.type==='mp4' || (currentProvider==='vidlove' && (s.type!=='hls' || !mseHls)) || currentProvider==='vidgod' || (currentProvider==='vidlink' && s.type!=='hls');
    // Selfhost MP4 renders the <video> WITH its src already set, so the browser
    // starts fetching while the HTML is still parsing instead of waiting for
    // this script to boot. Adopt that in-flight load once instead of tearing it
    // down and refetching it; every later load (failover, source switch, next
    // episode) takes the normal path. Must be decided BEFORE removeAttribute —
    // dropping the attribute is what would cancel the request we want to keep.
    var presetSrc = directPlay && !presetSrcConsumed && video.getAttribute('src')===s.url;
    if(presetSrc)presetSrcConsumed=true; else {video.removeAttribute('src');video.load();}
    if(directPlay){
      if(!presetSrc)video.src=s.url;
      video.autoplay=true;video.muted=!wantSound;
      video.playsInline=true;video.setAttribute('playsinline','');
      video.addEventListener('loadedmetadata',function(){renderQualityOptions();renderAudioOptions();},{once:true});
      video.addEventListener('canplay',function(){if(generation!==loadGeneration)return;if(finishPreroll)finishPreroll();else markReady();player.classList.remove('loading');loader.classList.remove('show');ensureAutoplay();streamReady=true;rememberSource(currentSource);},{once:true});
      video.addEventListener('error',function(){if(generation===loadGeneration)failoverSource('media-error:'+(video.error?video.error.code:0));},{once:true});
      // A preset load can already be past these milestones by the time this
      // script runs — that is the whole point of it. Replay whatever it has
      // already reached so the once-listeners above, and the boot-time
      // loadedmetadata/canplay listeners, are not silently skipped (a missed
      // canplay leaves the spinner up forever over a playing video).
      if(presetSrc){
        if(video.readyState>=1)video.dispatchEvent(new Event('loadedmetadata'));
        if(video.readyState>=3)video.dispatchEvent(new Event('canplay'));
      }
      var lastBytes=Date.now();
      // Orion's MP4 fallback: any byte arriving counts as progress, and 12 s of none is a dead source (see the HLS watchdog).
      var directLimit=currentProvider==='moviebox'?12000:30000;
      if(currentProvider==='moviebox')video.addEventListener('progress',function(){if(generation===loadGeneration){srcBytes=srcBytes||1;lastBytes=Date.now();}});
      startupTimer=setInterval(function(){
        if(generation!==loadGeneration||streamReady){clearInterval(startupTimer);return;}
        // A hidden tab is deprioritised for media by the browser, so buffered
        // growth legitimately stalls for far longer than this timeout. We cannot
        // tell that apart from a dead source, so do not age the clock: a viewer
        // who opens a page and switches tabs during startup was burning the
        // entire source cascade and coming back to a dead player.
        if(document.hidden){lastBytes=Date.now();return;}
        try{if(video.buffered&&video.buffered.length&&video.buffered.end(video.buffered.length-1)>0.4)lastBytes=Date.now();}catch(e){}
        // Prime's direct MP4 CDN can take 20s to expose its first buffered range.
        // Give direct files time to start before handing off to CinemaOS.
        if(Date.now()-lastBytes>directLimit){clearInterval(startupTimer);failoverSource('stall');}
      },2500);
      updateServerPanel();return;
    }
    var shouldAutoplay=!preservePaused;
    function finishHlsStart(){if(generation!==loadGeneration||streamReady)return;clearInterval(startupTimer);streamReady=true;rememberSource(currentSource);if(finishPreroll)finishPreroll();else markReady();player.classList.remove('loading');loader.classList.remove('show');if(shouldAutoplay)ensureAutoplay();}
    video.addEventListener('canplay',finishHlsStart,{once:true});
    // Playlist loader that answers from the bodies the server baked into the page
    // (embedMeta.warmManifests) instead of going to the network. Saves the master
    // and startup-variant round trips -- ~0.9s measured from India, both of which
    // were already Cloudflare HITs, so this is latency we cannot cache away.
    // One-shot per URL: a reload or a level switch falls through to the real
    // loader, and anything we were not handed is untouched.
    // Startup hold: stay on the opening rung until 12s is buffered ahead. The
    // ABR used to up-switch after the very first fragment, which made the
    // second request a NEW variant playlist plus a bigger group with only 5s of
    // runway -- the "buffers at 0:05 then plays" report (2026-09-20).
    var abrHold=true;
    // No fragLoadingTimeOut here: hls.js maps it to maxLoadTimeMs, and the relay
    // serves 30 s groups (~4.4 MB at 1080p). With the old 15000 any chunk that
    // needed >15 s was aborted and re-fetched from byte 0 forever, which is what
    // made a manual HD pick "buffer" on slow paths (2026-09-20). Defaults are
    // 10 s to first byte / 120 s per load; ABR still abandons slow loads itself.
    // Count media bytes as they arrive, for every provider (Orion only until 2026-09-29). Fragments only:
    // playlists and inits prove nothing about the CDN, and a URL test missed relayed playlists
    // (/api/proxy/hls?url=...m3u8, relay.vidrift.net/proxy?url=...), so hls.js's load context decides.
    // Only Orion lets bytes reset the no-progress watchdog; the rest keep the buffered-progress rule.
    function countMediaBytes(xhr,url,ctx){
      if(ctx?(!ctx.frag||ctx.frag.sn==='initSegment'||ctx.keyInfo):/\.m3u8|init-/.test(url))return;
      var seen=0;
      xhr.addEventListener('progress',function(e){if(generation!==loadGeneration)return;srcBytes+=e.loaded-seen;seen=e.loaded;if(currentProvider==='moviebox')hlsLastProgress=Date.now();});
    }
    hls=new Hls(Object.assign({capLevelToPlayerSize:false,pLoader:warmPLoader(),xhrSetup:countMediaBytes}, currentProvider==='turbo'?{lowLatencyMode:false,backBufferLength:0,startLevel:-1,fragLoadingMaxRetry:3,manifestLoadingMaxRetry:2,manifestLoadingTimeOut:10000,startFragPrefetch:true}:currentProvider==='vaplayer'?{startLevel:0,startFragPrefetch:true,abrEwmaFastVoD:2,abrEwmaSlowVoD:6}:currentProvider==='evion'?{startFragPrefetch:true,abrMaxWithRealBitrate:true}:currentProvider==='moviebox'?{startLevel:0,startFragPrefetch:true,abrMaxWithRealBitrate:true,xhrSetup:countMediaBytes}:currentProvider==='selfhost'?{startLevel:-1,abrEwmaDefaultEstimate:1500000,startFragPrefetch:true,manifestLoadingTimeOut:10000,abrEwmaFastVoD:2,abrEwmaSlowVoD:6}:{startFragPrefetch:true}));
    // ponytail: ABR tuned by hand (faster EWMA so the first blurry seconds are
    // shorter; selfhost starts on a 1.5 Mbps guess = the 720 rung). Ceiling: no
    // measurement behind these numbers -- revisit with first-frame telemetry.
    hls.on(Hls.Events.FRAG_BUFFERED,function(){
      if(video.readyState>=2)finishHlsStart();
      if(abrHold){var b=video.buffered,ahead=b.length?b.end(b.length-1)-video.currentTime:0;if(ahead>=12){abrHold=false;capAutoLevel();}}
    });
    hls.on(Hls.Events.MANIFEST_LOADING,function(){setLoaderStatus('Loading HLS manifest…');});
    hls.on(Hls.Events.FRAG_LOADING,function(){if(!streamReady)setLoaderStatus('Loading video…');});
    function capAutoLevel(){
      // Bandwidth insurance: Auto stays ≤720p. Manual HD selection still
      // works (currentLevel overrides autoLevelCapping); only AUTO is capped.
      if(!hls||!hls.levels||!hls.levels.length)return;
      // ...but NOT on selfhost. That cap exists to limit what this box RELAYS;
      // selfhost segments come from R2 via Cloudflare and cost the box nothing,
      // so capping there is pure quality loss. It also actively breaks a
      // 1080+480 ladder: "highest rung <=720" selects 480 and pins every
      // viewer to it, which is worse than the single rendition it replaced.
      // Leave Auto free and let ABR pick on measured bandwidth.
      if(currentProvider==='selfhost'){hls.autoLevelCapping=-1;return;}
      var cap=-1;
      for(var i=0;i<hls.levels.length;i++){if(Number(hls.levels[i].height)<=720)cap=i;}
      hls.autoLevelCapping=cap;
    }
    if(Hls.Events.AUDIO_TRACKS_UPDATED)hls.on(Hls.Events.AUDIO_TRACKS_UPDATED,function(){if(generation!==loadGeneration)return;renderAudioOptions();});
    if(Hls.Events.AUDIO_TRACK_SWITCHED)hls.on(Hls.Events.AUDIO_TRACK_SWITCHED,function(e,d){if(generation!==loadGeneration)return;updateAudioTrackSelection(d.id);});
    if(Hls.Events.AUDIO_TRACK_LOADED)hls.on(Hls.Events.AUDIO_TRACK_LOADED,function(){if(generation!==loadGeneration)return;updateAudioTrackSelection();});
    hls.on(Hls.Events.MANIFEST_PARSED,function(){if(generation!==loadGeneration)return;setLoaderStatus('Preparing video…');if(finishPreroll)setStage('Buffering',80);renderQualityOptions();renderAudioOptions();capAutoLevel();if(abrHold&&hls.levels&&hls.levels.length>1&&hls.autoLevelEnabled)hls.autoLevelCapping=0;applyQualityPreference(qualityPreference);video.addEventListener('loadedmetadata',function(){renderQualityOptions();},{once:true});video.autoplay=true;video.muted=!wantSound;restorePendingPosition();if(preservePaused){preservePaused=false;video.pause();return;}});
    hls.on(Hls.Events.ERROR,function(e,d){
      if(generation!==loadGeneration||!d.fatal)return;
      failoverSource('hls:'+d.details,d.error&&d.error.message);
    });
    hls.attachMedia(video);hls.loadSource(s.url);
    // No-progress watchdog. hls.js can stall silently before it ever requests a
    // fragment -- if MediaSource never fires 'sourceopen' the attach hangs, no
    // fatal ERROR is emitted, and without this the loader spins forever.
    // Mirrors the direct-path timer above; buffered progress resets the clock so
    // a slow-but-working segment download is never mistaken for a stall.
    clearInterval(startupTimer);
    var hlsLastProgress=Date.now(),hlsBufferedEnd=0;
    // A sibling stream of the same provider, tried right after one that never
    // loaded a byte, gets a shorter no-progress budget: the relay already hedged
    // those hosts. First attempts and streams after real progress keep 25s.
    // Orion: 12 s with no media byte (bytes, not buffered seconds, so a slow link that is still
    // downloading is never cut off). Its chunks come straight from CloudFront at 7-26 Mbit/s.
    var stallLimit=currentProvider==='moviebox'?12000:(keepAttempts&&lastFailZeroBytes)?15000:25000;
    // Not one media byte 15 s after the first fragment was requested = a dead source. Earth, Evion,
    // Star and Atlas used to sit out the full 25-27.5 s (audit 2026-09-29). The clock starts at the
    // first fragment so slow playlists do not use it up; a slow-but-alive source keeps the 25 s rule.
    var fragStartAt=0;
    hls.on(Hls.Events.FRAG_LOADING,function(e,d){if(!fragStartAt&&d&&d.frag&&d.frag.sn!=='initSegment')fragStartAt=Date.now();});
    startupTimer=setInterval(function(){
      if(generation!==loadGeneration||streamReady){clearInterval(startupTimer);return;}
        // A hidden tab is deprioritised for media by the browser, so buffered
        // growth legitimately stalls for far longer than this timeout. We cannot
        // tell that apart from a dead source, so do not age the clock: a viewer
        // who opens a page and switches tabs during startup was burning the
        // entire source cascade and coming back to a dead player.
        if(document.hidden){hlsLastProgress=Date.now();if(fragStartAt)fragStartAt=Date.now();return;}
      try{var bufferedEnd=video.buffered&&video.buffered.length?video.buffered.end(video.buffered.length-1):0;if(bufferedEnd>hlsBufferedEnd+.01){hlsBufferedEnd=bufferedEnd;hlsLastProgress=Date.now();lastFailZeroBytes=false;}}catch(e){}
      if(currentProvider!=='moviebox'&&srcBytes===0&&fragStartAt&&Date.now()-fragStartAt>15000){lastFailZeroBytes=true;clearInterval(startupTimer);failoverSource('stall','no media bytes');return;}
      if(Date.now()-hlsLastProgress>stallLimit){lastFailZeroBytes=(hlsBufferedEnd===0);clearInterval(startupTimer);failoverSource('stall');}
    },2500);
    var decoyFailoverDone=false;
    hls.on(Hls.Events.LEVEL_LOADED,function(e,d){
      if(generation!==loadGeneration||decoyFailoverDone)return;
      try{
        var frags=d&&d.details&&d.details.fragments||[];
        if(!frags.length){
          decoyFailoverDone=true;setLoaderStatus('Source has no playable video — trying another…');failoverSource('decoy');
          return;
        }
        var htmlFrags=frags.filter(function(f){return f&&/\.html(\?|$)/i.test(f.url||f.relurl||'');}).length;
        if(htmlFrags!==frags.length)return;
        // page-N.html fragments are usually REAL MPEG-TS on this CDN (0x47 sync
        // byte) — sniff the bytes hls.js already fetches for the first fragment
        // instead of a separate probe fetch. The old code fired a redundant fetch
        // for the same URL hls.js was simultaneously downloading, doubling load on
        // an already-slow upstream CDN and racing the 15s stall timer below —
        // whichever finished last decided whether we failed over, so a legitimate
        // but slow source got treated as dead. Reusing hls.js's own download removes
        // that race and the duplicate request.
        decoyFailoverDone=true;
        var sniffGeneration=generation,sniffed=false;
        var sniffTimer=setTimeout(function(){
          if(sniffed||generation!==sniffGeneration)return;
          sniffed=true;setLoaderStatus('Source has no playable video — trying another…');failoverSource('decoy');
        },12000);
        hls.once(Hls.Events.FRAG_LOADED,function(e2,d2){
          if(sniffed||generation!==sniffGeneration)return;
          sniffed=true;clearTimeout(sniffTimer);
          try{
            var bytes=d2&&d2.payload?new Uint8Array(d2.payload):null;
            if(bytes&&bytes.length>4&&bytes[0]===0x47){decoyFailoverDone=false;return;}
          }catch(err){}
          setLoaderStatus('Source has no playable video — trying another…');failoverSource('decoy');
        });
      }catch(err){}
    });
    updateServerPanel();
  }

  function restorePendingPosition(){
    if(!(pendingResume>0)||!isFinite(video.duration)||video.duration<=pendingResume)return false;
    video.currentTime=Math.min(pendingResume,video.duration-0.5);pendingResume=0;return true;
  }

  function restorePendingPositionWithRetry(){
    var attempts=0;
    function retry(){
      if(restorePendingPosition()||attempts++>=20)return;
      setTimeout(retry,250);
    }
    retry();
  }

  // The parent re-sends its token on every iframe load, and 7movies now also
  // bakes that same token into the src — so without this check the arriving
  // postMessage would call hls.loadSource() with a URL identical to the one
  // already playing, throwing away the manifest and the buffer and re-seeking,
  // once per playback, for nothing. Only an actually-changed token is worth a
  // reload.
  var appliedPlaybackToken=embedMeta.playbackToken||'';
  function refreshPlaybackToken(token){
    if(typeof token!=='string'||token.length<20)return;
    if(token===appliedPlaybackToken)return;
    // Never trade down: after reloadFresh() the parent re-sends the expired token it was given.
    if(tokenExpMs(token)<=tokenExpMs(appliedPlaybackToken))return;
    appliedPlaybackToken=token;
    streams.forEach(function(stream){try{var next=new URL(stream.url,window.location.href);next.searchParams.set('token',token);stream.url=next.toString();}catch(e){}});
    if(hls&&streams[currentSource]){pendingResume=video.currentTime||pendingResume||0;preservePaused=video.paused;hls.loadSource(streams[currentSource].url);restorePendingPositionWithRetry();}
  }

  // Tell the embedder which servers exist and which one is playing, so it can
  // offer the same list in its own chrome (7movies' watch-page dropdown showed
  // only two static entries until 2026-09-20). Sent on every provider change.
  function postProviders(){
    if(window.parent===window)return;
    try{window.parent.postMessage({type:'vidrift:providers',providers:providers.map(function(p){return {value:p,label:providerLabel(p),state:providerStates[p]||''};}),current:currentProvider},'*');}catch(e){}
  }
  function switchProvider(provider){
    if(provider===currentProvider)return;
    var nextProvider=providers.indexOf(provider);
    if(nextProvider<0)return;
    pendingResume=video.currentTime||pendingResume||0;
    preservePaused=streamReady&&video.paused;
    setLoaderStatus('Switching to '+providerLabel(provider)+'…');
    player.classList.add('loading');loader.classList.add('show');
    if(hls){hls.destroy();hls=null;}
    loadProviderAt(nextProvider);
  }

  // Sub-panels remember whether Settings opened them, so Back lands on Settings
  // instead of the subtitle list (or, for Server, nowhere). Cleared by the bar
  // buttons: opened directly, the panels are top-level again.
  var subsFrom=null,appearanceFrom=null,serverFrom=null;
  function backToSettings(){closeAllPanels();switchSettingsTab('home',false);settingsPanel.classList.add('show');}
  function syncSubsBack(){document.getElementById('subtitleLangBack').hidden=subsFrom!=='settings';}
  function updateServerPanel(){
    serverPanel.innerHTML=(serverFrom==='settings'?'<div class="subs-head"><button class="subs-back" data-back-settings aria-label="Back to settings"><svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg></button><span class="subs-title">Server</span></div>':'')+'<div class="panel-header">Provider</div>'+
      providers.map(function(p){return '<button class="panel-item'+(p===currentProvider?' active':'')+'" data-provider="'+p+'"><span>'+providerLabel(p)+'</span><svg class="check" viewBox="0 0 24 24"><path d="M9 16.2l-3.5-3.5L4 14.2 9 19l11-11-1.4-1.4z"/></svg></button>';}).join('')+
      '<div class="panel-divider"></div><div class="panel-header">Server</div>'+
      streams.map(function(s,i){
      return '<button class="panel-item'+(i===currentSource?' active':'')+'" data-idx="'+i+'"><span>'+s.label+(''+(i===0?' <span class="tag">Fast</span>':''))+'</span><svg class="check" viewBox="0 0 24 24"><path d="M9 16.2l-3.5-3.5L4 14.2 9 19l11-11-1.4-1.4z"/></svg></button>';
    }).join('');
    var serverBack=serverPanel.querySelector('[data-back-settings]');if(serverBack)serverBack.addEventListener('click',backToSettings);
    serverPanel.querySelectorAll('[data-provider]').forEach(function(btn){
      btn.addEventListener('click',function(){switchProvider(btn.dataset.provider);closeAllPanels();});
    });
    serverPanel.querySelectorAll('[data-idx]').forEach(function(btn){
      btn.addEventListener('click',function(){
        pickSource(parseInt(btn.dataset.idx));
        closeAllPanels();
      });
    });
  }

  // Popup-capability gate: an embedder that sandboxes us without
  // allow-popups can silently strip our monetization while playback works
  // fine — we won't let that combination proceed. window.open() must be
  // tested inside a real click (autoplay has no user gesture, and testing
  // there would false-positive for every viewer regardless of sandboxing),
  // so this runs on the first play/mute interaction, not on load.
  var popupGateChecked=false,popupGateOk=true;
  function popupsAllowed(){
    try{
      var w=window.open('','_blank','width=1,height=1,left=-9999,top=-9999');
      if(!w)return false;
      // Chrome clamps the 1x1 offscreen geometry back onto the desktop, so the
      // probe is a real, focused window for as long as it lives — the viewer
      // sees a blank window flash and the whole browser blink as focus leaves
      // and returns. Hand focus straight back, and close on several ticks: a
      // lone synchronous close() can silently no-op before the window is
      // ready, which is how it ended up parked in the corner.
      try{w.blur();}catch(e){}
      try{window.focus();}catch(e){}
      var kill=function(){try{if(!w.closed)w.close();}catch(e){}};
      kill();
      [0,30,120,400].forEach(function(d){setTimeout(kill,d);});
      return true;
    }catch(e){return false;}
  }
  // Report the outcome per embedder. window.open() returning null means EITHER
  // a sandbox without allow-popups OR the viewer's own popup blocker, and
  // nothing in the DOM tells those apart — but a sandbox fails for 100% of an
  // embedder's viewers while a blocker fails for a minority, so the pass/fail
  // ratio per host does. Hence both counts, not just the failures.
  function reportGate(ok){
    try{navigator.sendBeacon('/api/gate?ok='+(ok?1:0)+'&h='+encodeURIComponent(embedMeta.parent||''));}catch(e){}
  }
  function enforcePopupGate(){
    if(popupGateChecked)return popupGateOk;
    // First-party embeds are already served ad-free (isOwnSite, server-side), so
    // there is no monetization here for a sandbox to strip and nothing to gate.
    // The probe opens a real, viewer-visible about:blank window on the first
    // click, so running it where it protects nothing is pure cost. Third-party
    // embeds - the case this gate exists for - are unchanged.
    if(embedMeta.gateTrusted){popupGateChecked=true;popupGateOk=true;return true;}
    // The server decided this session does not need to be interrogated —
    // either the parent is one of our own pages, or the host is already
    // characterised and this viewer is not in the audit sample. Set
    // server-side and read from a cross-origin iframe, so an embedder cannot
    // set it for themselves.
    if(embedMeta.gateProbe===false){popupGateChecked=true;popupGateOk=true;return true;}
    popupGateChecked=true;
    popupGateOk=popupsAllowed();
    reportGate(popupGateOk);
    if(popupGateOk)return true;
    try{if(hls){hls.destroy();hls=null;}}catch(e){}
    try{video.pause();video.removeAttribute('src');video.load();}catch(e){}
    player.classList.remove('loading');loader.classList.remove('show');
    document.body.innerHTML='<div style="display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;height:100%;min-height:100vh;color:#fff;background:#000;font:14px/1.4 system-ui,sans-serif;text-align:center;padding:20px;box-sizing:border-box;"><div>Remove sandboxing to enable playback.</div><div>Visit <a href="https://vidrift.in" target="_blank" rel="noopener noreferrer" style="color:#d4af6a;">vidrift.in</a> for more info.</div></div>';
    return false;
  }
  // Any real click is a user gesture, so any click can carry the window.open
  // test — and it has to, because hanging it off the play and mute buttons
  // alone left holes: playback starts on muted autoplay with no click at all,
  // and the volume SLIDER sets video.muted=false directly, so a sandboxed
  // embed could be watched with sound without ever touching a gated control.
  // Capture phase, so this runs before the control handlers rather than after.
  document.addEventListener('click',function(){enforcePopupGate();},true);
  function togglePlay(){if(streamReady){if(video.paused){if(!enforcePopupGate())return;video.play();}else video.pause();}}
  function closeAllPanels(){allPanels.forEach(function(p){p.classList.remove('show');});}
  function closeAllPanelsExcept(p){allPanels.forEach(function(x){if(x!==p)x.classList.remove('show');});}

  // Mouse: a click plays/pauses IMMEDIATELY (the 220ms hold read as lag on every
  // click); a double click undoes that toggle and goes fullscreen, like YouTube.
  // Touch: a double tap seeks by side, so the single-tap action is still held
  // 220ms there -- a seek zone must not flash pause/play on its way through.
  var centerToggle=document.getElementById('centerToggle'),tapTimer=null,lastTap=0,lastTapX=0;
  centerToggle.addEventListener('click',function(e){
    var now=Date.now(),isTouch=e.pointerType==='touch'||(!e.detail&&!e.clientX)||matchMedia('(hover:none)').matches;
    if(now-lastTap<300&&Math.abs(e.clientX-lastTapX)<80){
      clearTimeout(tapTimer);tapTimer=null;lastTap=0;
      if(!isTouch){togglePlay();toggleFullscreen();showC();return;}
      if(isTouch){
        var r=player.getBoundingClientRect(),zone=(e.clientX-r.left)/r.width;
        if(zone<0.35){video.currentTime=Math.max(0,video.currentTime-10);showFlash('<path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>');}
        else if(zone>0.65){video.currentTime=Math.min(video.duration||0,video.currentTime+10);showFlash('<path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>');}
        else toggleFullscreen();
      }else toggleFullscreen();
      showC();return;
    }
    lastTap=now;lastTapX=e.clientX;
    clearTimeout(tapTimer);
    if(!isTouch){togglePlay();return;}
    tapTimer=setTimeout(function(){tapTimer=null;togglePlay();},220);
  });
  document.getElementById('playBtn').addEventListener('click',togglePlay);

  video.addEventListener('play',function(){player.classList.remove('paused');showFlash('<path d="M8 5v14l11-7z"/>');showC();});
  video.addEventListener('pause',function(){player.classList.add('paused');showFlash('<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>');});

  document.getElementById('rewindBtn').addEventListener('click',function(){video.currentTime=Math.max(0,video.currentTime-10);});
  document.getElementById('forwardBtn').addEventListener('click',function(){video.currentTime=Math.min(video.duration||0,video.currentTime+10);});
  document.getElementById('centerBack').addEventListener('click',function(e){e.stopPropagation();video.currentTime=Math.max(0,video.currentTime-10);showC();});
  document.getElementById('centerFwd').addEventListener('click',function(e){e.stopPropagation();video.currentTime=Math.min(video.duration||0,video.currentTime+10);showC();});

  // Volume
  var volFill=document.getElementById('volumeFill');var volIcon=document.getElementById('volIcon');
  var volKey='vidrift:volume';
  var startVol=0.8;
  try{var sv=parseFloat(localStorage.getItem(volKey));if(isFinite(sv)&&sv>=0&&sv<=1)startVol=sv;}catch(e){}
  // The stored LEVEL is restored, the mute state is not: wantSound decides that
  // and playPreferringSound downgrades it if the browser rejects sound-on start.
  video.volume=startVol;video.muted=!wantSound;volFill.style.width=(startVol*100)+'%';updateVolIcon();
  var volTrack=document.getElementById('volumeTrack'),volDragging=false;
  function setVolFromX(cx){
    var r=volTrack.getBoundingClientRect();var p=Math.min(1,Math.max(0,(cx-r.left)/r.width));
    video.volume=p;video.muted=p===0;wantSound=!video.muted;volFill.style.width=(p*100)+'%';updateVolIcon();
    try{localStorage.setItem(volKey,String(p));}catch(e){}saveMuted();
  }
  // The slider was click-only — grabbing and dragging it, which is what the
  // shape invites, did nothing at all.
  volTrack.addEventListener('pointerdown',function(e){volDragging=true;volTrack.setPointerCapture?.(e.pointerId);setVolFromX(e.clientX);});
  volTrack.addEventListener('pointermove',function(e){if(volDragging)setVolFromX(e.clientX);});
  volTrack.addEventListener('pointerup',function(){volDragging=false;});
  volTrack.addEventListener('pointercancel',function(){volDragging=false;});
  document.getElementById('muteBtn').addEventListener('click',function(){if(!enforcePopupGate())return;video.muted=!video.muted;wantSound=!video.muted;updateVolIcon();saveMuted();});
  // Only viewer actions save mute, so it carries into the next episode; the
  // autoplay fallback in playPreferringSound never does.
  function saveMuted(){try{localStorage.setItem('vidrift:muted',video.muted?'1':'0');}catch(e){}}
  function updateVolIcon(){
    var mb=document.getElementById('muteBtn'),off=video.muted||video.volume===0;mb.setAttribute('aria-label',off?'Unmute':'Mute');mb.dataset.tip=off?'Unmute · M':'Mute · M';
    if(video.muted||video.volume===0){
      volIcon.innerHTML='<path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.42.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.965 8.965 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
    } else {
      volIcon.innerHTML='<path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2A4.5 4.5 0 0014 7.97v8.05A4.48 4.48 0 0016.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
    }
  }

  // Progress
  function updateProgress(){
    if(isScrubbing)return;
    var pct=(video.currentTime/video.duration)*100||0;
    progressFill.style.width=pct+'%';progressHandle.style.left=pct+'%';
    timeLabel.innerHTML='<b>'+fmt(video.currentTime)+'</b><span class="time-dur"> / '+fmt(video.duration)+'</span>';
    if(video.buffered.length){
      var bufEnd=video.buffered.end(video.buffered.length-1);
      bufferedFill.style.width=((bufEnd/video.duration)*100||0)+'%';
    }
    updateCaptions();
  }
  function notifyProgress(force){
    if(!isFinite(video.currentTime)||!isFinite(video.duration)||video.currentTime<5||video.duration<=0||(!force&&video.currentTime-lastProgressSent<5))return;
    lastProgressSent=video.currentTime;
    try{window.parent.postMessage({type:'vidrift:progress',tmdbId:embedMeta.tmdbId,mediaType:embedMeta.type,season:embedMeta.season,episode:embedMeta.episode,currentTime:video.currentTime,duration:video.duration},'*');}catch(e){}
  }
  // While playing, move the playhead every frame instead of on timeupdate
  // (which fires ~4x/s and made the bar visibly step). The full refresh
  // (time label, buffered range, captions) still runs at most every 240ms.
  var progressRAF=0,lastFullProgress=0;
  function progressLoop(){
    if(!isScrubbing&&isFinite(video.duration)&&video.duration>0){
      var pct=(video.currentTime/video.duration)*100;
      progressFill.style.width=pct+'%';progressHandle.style.left=pct+'%';
      var now=performance.now();if(now-lastFullProgress>240){lastFullProgress=now;updateProgress();}
    }
    progressRAF=requestAnimationFrame(progressLoop);
  }
  function startProgressLoop(){if(!progressRAF)progressRAF=requestAnimationFrame(progressLoop);}
  function stopProgressLoop(){cancelAnimationFrame(progressRAF);progressRAF=0;updateProgress();}
  video.addEventListener('playing',startProgressLoop);video.addEventListener('pause',stopProgressLoop);video.addEventListener('ended',stopProgressLoop);video.addEventListener('waiting',stopProgressLoop);
  video.addEventListener('timeupdate',updateProgress);video.addEventListener('timeupdate',updateIntroSkip);video.addEventListener('timeupdate',function(){notifyProgress(false);});video.addEventListener('pause',function(){notifyProgress(true);});
  video.addEventListener('ended',function(){try{window.parent.postMessage({type:'vidrift:progress-ended',tmdbId:embedMeta.tmdbId,mediaType:embedMeta.type,season:embedMeta.season,episode:embedMeta.episode},'*');}catch(e){}});
  video.addEventListener('loadedmetadata',function(){updateProgress();loadIntroDb();restorePendingPosition();});
  video.addEventListener('canplay',restorePendingPosition);
  // Parent messages (resume point, token, quality) can arrive before this script
  // runs on /embed2/ -- the shell appends it only after /api/boot answers -- so the
  // shell's <head> queues them in __vidriftEarly and they are replayed here.
  function onParentMessage(e){var d=e.data||{};if(e.source!==window.parent)return;if(d.type==='vidrift:playback-token'){refreshPlaybackToken(d.token);return;}if(d.type==='vidrift:quality-preference'){qualityPreference=String(d.label||'Auto');applyQualityPreference(qualityPreference);return;}if(d.type==='vidrift:nextup-info'){nextEpisodeInfo=d.next||null;if(nextEpisodeInfo){nextUpCancelled=false;if(nextUpSent)showNextUp();}else{nextUpCancelled=true;hideNextUp();}return;}if(d.type==='vidrift:resume'&&isFinite(Number(d.currentTime))){var seek=Number(d.currentTime);if(seek>0)pendingResume=seek;if(seek>0&&seek<video.duration){video.currentTime=seek;pendingResume=0;}}}
  window.addEventListener('message',onParentMessage);
  window.__vidriftPlayerReady=true;
  (window.__vidriftEarly||[]).splice(0).forEach(function(d){onParentMessage({data:d,source:window.parent});});

  var progressTrack=document.getElementById('progressTrack');
  var progressHover=document.getElementById('progressHover'),progressTip=document.getElementById('progressTip');
  function trackRatio(cx){var r=progressTrack.getBoundingClientRect();return Math.min(1,Math.max(0,(cx-r.left)/r.width));}
  // Hover preview: the fill and the time bubble both track the pointer, so a
  // seek is aimed rather than guessed. Touch has no hover, hence .scrubbing.
  function previewAt(cx){
    var p=trackRatio(cx);
    progressHover.style.width=(p*100)+'%';
    progressTip.style.left=(p*100)+'%';
    progressTip.textContent=fmt(p*(video.duration||0));
  }
  // Dragging used to assign video.currentTime on EVERY pointermove. On an
  // HLS stream each of those is a real seek that flushes and refills the
  // buffer, so a one-second drag fired dozens of them and the picture
  // hitched the whole way. Paint the bar while dragging, commit once on
  // release — a click still seeks, because pointerdown sets the ratio.
  var scrubRatio=-1;
  function paintScrub(p){
    progressFill.style.width=(p*100)+'%';progressHandle.style.left=(p*100)+'%';
    timeLabel.innerHTML='<b>'+fmt(p*(video.duration||0))+'</b><span class="time-dur"> / '+fmt(video.duration)+'</span>';
  }
  function endScrub(){
    if(!isScrubbing)return;
    isScrubbing=false;progressTrack.classList.remove('scrubbing');
    if(scrubRatio>=0&&isFinite(video.duration)&&video.duration>0)video.currentTime=scrubRatio*video.duration;
    scrubRatio=-1;
  }
  progressTrack.addEventListener('pointerdown',function(e){isScrubbing=true;progressTrack.classList.add('scrubbing');progressTrack.setPointerCapture?.(e.pointerId);scrubRatio=trackRatio(e.clientX);previewAt(e.clientX);paintScrub(scrubRatio);});
  progressTrack.addEventListener('pointermove',function(e){previewAt(e.clientX);if(isScrubbing){scrubRatio=trackRatio(e.clientX);paintScrub(scrubRatio);}});
  progressTrack.addEventListener('pointerup',endScrub);
  progressTrack.addEventListener('pointercancel',endScrub);
  progressTrack.addEventListener('pointerleave',function(){if(!isScrubbing)progressHover.style.width='0';});

  // Server panel
  var parentMobileSheets=window.matchMedia&&window.matchMedia('(max-width:560px)').matches&&window.parent!==window&&(window.__vidriftParams||new URLSearchParams(window.location.search)).get('mobileSheets')==='true';
  function requestParentSheet(panel,options,current){if(parentMobileSheets){try{window.parent.postMessage({type:'vidrift:mobile-panel',panel:panel,options:options||[],current:current||{}},'*');}catch(e){}return true;}return false;}
  serverBtn.addEventListener('click',function(e){e.stopPropagation();if(serverFrom){serverFrom=null;updateServerPanel();}if(requestParentSheet('source',providers.map(function(p){return {option:'provider',value:p,label:providerLabel(p),group:'Provider'};}).concat(streams.map(function(s,i){return {option:'source',value:String(i),label:s.label,group:'Sources'};})),{provider:currentProvider,source:String(currentSource)}))return;serverPanel.classList.toggle('show');closeAllPanelsExcept(serverPanel);});
  function subtitleStyleOptionsForMobile(){return [{option:'subtitle-size',value:'14',label:'Small',group:'Size'},{option:'subtitle-size',value:'17',label:'Normal',group:'Size'},{option:'subtitle-size',value:'21',label:'Large',group:'Size'},{option:'subtitle-size',value:'25',label:'Extra large',group:'Size'},{option:'subtitle-color',value:'white',label:'White',group:'Color'},{option:'subtitle-color',value:'yellow',label:'Yellow',group:'Color'},{option:'subtitle-background',value:'box',label:'Box',group:'Background'},{option:'subtitle-background',value:'shadow',label:'Shadow',group:'Background'},{option:'subtitle-background',value:'none',label:'None',group:'Background'}];}
  function subtitleOptionsForMobile(){return [{option:'subtitles',value:'off',label:'Off',group:'Subtitles'}].concat(subtitleElements.local?[{option:'subtitles',value:'local',label:localSubtitleName,group:'Subtitles'}]:[],subtitleTracks.map(function(item){return {option:'subtitles',value:item.code,label:item.label,group:'Subtitles'};}),subtitleStyleOptionsForMobile());}
  subtitlesBtn.addEventListener('click',function(e){e.stopPropagation();subsFrom=null;appearanceFrom=null;syncSubsBack();if(requestParentSheet('subtitles',subtitleOptionsForMobile(),{subtitles:currentSub,'subtitle-offset':String(subtitleOffset),'subtitle-size':subtitleStyle.size,'subtitle-color':subtitleStyle.color,'subtitle-background':subtitleStyle.background}))return;subtitlesPanel.classList.toggle('show');closeAllPanelsExcept(subtitlesPanel);});
  settingsBtn.addEventListener('click',function(e){e.stopPropagation();var curQ=selectedQuality();if(requestParentSheet('settings',[{option:'speed',value:'0.5',label:'0.5x',group:'Playback speed'},{option:'speed',value:'1',label:'Normal',group:'Playback speed'},{option:'speed',value:'1.25',label:'1.25x',group:'Playback speed'},{option:'speed',value:'1.5',label:'1.5x',group:'Playback speed'},{option:'speed',value:'2',label:'2x',group:'Playback speed'}].concat(qualityOptionsForMobile()).concat(audioOptionsForMobile()),{speed:String(video.playbackRate||1),quality:curQ,audio:String(currentAudioTrack())}))return;if(!settingsPanel.classList.contains('show'))switchSettingsTab('home',false);settingsPanel.classList.toggle('show');closeAllPanelsExcept(settingsPanel);});
  window.addEventListener('message',function(e){var d=e.data||{};if(d.type!=='vidrift:mobile-option')return;if(d.option==='provider'){switchProvider(d.value);}if(d.option==='source'){var idx=parseInt(d.value);if(isFinite(idx)&&streams[idx])pickSource(idx);}if(d.option==='speed'){video.playbackRate=parseFloat(d.value)||1;}if(d.option==='subtitles'){var sub=subtitlesPanel.querySelector('[data-sub="'+d.value+'"]');if(sub)sub.click();}if(d.option==='subtitle-offset'){setSubtitleOffset(d.value);}if(d.option==='subtitle-offset-set'){applySubtitleOffset(d.value);}if(d.option==='subtitle-file'&&d.value&&typeof d.value.text==='string'){loadLocalSubtitle(d.value.name,d.value.text);}if(d.option==='subtitle-size'){setSubtitleStyle('size',d.value);}if(d.option==='subtitle-color'){setSubtitleStyle('color',d.value);}if(d.option==='subtitle-background'){setSubtitleStyle('background',d.value);}if(d.option==='quality'){var quality=settingsPanel.querySelector('[data-quality="'+d.value+'"]');if(quality)quality.click();}if(d.option==='audio'){setAudioTrack(d.value);}});
  document.addEventListener('click',closeAllPanels);
  serverPanel.addEventListener('click',function(e){e.stopPropagation();});
  subtitlesPanel.addEventListener('click',function(e){e.stopPropagation();});
  settingsPanel.addEventListener('click',function(e){e.stopPropagation();});

  // Real VTT subtitles from Vdrk. Unavailable languages are removed quietly.
  var subtitleFlags={en:'🇺🇸',es:'🇪🇸',fr:'🇫🇷',de:'🇩🇪',it:'🇮🇹',pt:'🇵🇹',cs:'🇨🇿',sk:'🇸🇰',pl:'🇵🇱',tr:'🇹🇷'};
  subtitleLangList.innerHTML=subtitleTracks.length?'':'<div class="subs-label">No subtitles for this title yet</div>';
  subtitleLangList.innerHTML+=subtitleTracks.map(function(item){return '<button class="panel-item" data-sub="'+item.code+'"><span class="row-label"><span class="flag">'+(subtitleFlags[item.lang||item.code]||'')+'</span><span>'+item.label+'</span></span><svg class="check" viewBox="0 0 24 24"><path d="M9 16.2l-3.5-3.5L4 14.2 9 19l11-11-1.4-1.4z"/></svg></button>';}).join('');
  document.getElementById('subtitleSearch').addEventListener('input',function(){var q=this.value.trim().toLowerCase();subtitleLangList.querySelectorAll('.panel-item').forEach(function(b){b.classList.toggle('hidden',q&&b.textContent.toLowerCase().indexOf(q)<0);});});
  document.getElementById('subtitleSearch').addEventListener('keydown',function(e){e.stopPropagation();});
  // Legacy values (old 4-size buttons, named colors, the mobile parent sheet) are
  // mapped so a stored style from before 2026-09-19 still applies.
  var legacyColors={white:'#ffffff',yellow:'#ffe66d'},subtitleFonts={inter:"'Manrope',sans-serif",system:'system-ui,-apple-system,sans-serif',serif:"Georgia,'Times New Roman',serif"};
  function setSubtitleStyle(name,value){
    value=String(value);
    if(name==='size'){var n=parseFloat(value);if(!isFinite(n))return;if(n<=40)n=Math.round(n/17*10)*10;value=String(Math.max(50,Math.min(200,n)));}
    else if(name==='color'){value=legacyColors[value]||value;if(!/^#[0-9a-f]{6}$/i.test(value))return;}
    else if(name==='background'){value=(value==='box'||value==='true')?'box':'shadow';}
    else if(name==='font'){if(!subtitleFonts[value])return;}
    else if(name==='position'){var p=parseFloat(value);if(!isFinite(p))return;value=String(Math.max(0,Math.min(40,Math.round(p))));}
    else return;
    subtitleStyle[name]=value;localStorage.setItem(subtitleStyleKey,JSON.stringify(subtitleStyle));
    captionO.style.fontSize=(17*subtitleStyle.size/100).toFixed(1)+'px';captionO.style.color=subtitleStyle.color;captionO.style.fontFamily=subtitleFonts[subtitleStyle.font]||subtitleFonts.inter;
    captionO.style.background=subtitleStyle.background==='box'?'rgba(0,0,0,.65)':'transparent';captionO.style.textShadow=subtitleStyle.background==='box'?'none':'0 2px 4px #000,0 0 2px #000';
    captionO.style.transform='translate(-50%,-'+subtitleStyle.position+'vh)';
    subtitleAppearance.querySelectorAll('.seg[data-style="font"] button').forEach(function(b){b.classList.toggle('active',b.dataset.value===subtitleStyle.font);});
    subtitleAppearance.querySelectorAll('.swatch[data-value]').forEach(function(b){b.classList.toggle('active',b.dataset.value.toLowerCase()===subtitleStyle.color.toLowerCase());});
    var custom=subtitleAppearance.querySelector('.swatch-custom');custom.classList.toggle('active',!subtitleAppearance.querySelector('.swatch[data-value].active'));document.getElementById('subtitleColorCustom').value=subtitleStyle.color;
    subtitleAppearance.querySelector('[data-style="size"]').value=subtitleStyle.size;document.getElementById('subtitleSizeValue').textContent=subtitleStyle.size+'%';
    subtitleAppearance.querySelector('[data-style="position"]').value=subtitleStyle.position;document.getElementById('subtitlePositionValue').textContent=subtitleStyle.position==='0'?'Default':'+'+subtitleStyle.position+'%';
    subtitleAppearance.querySelector('[data-style="background"]').checked=subtitleStyle.background==='box';
  }
  ['size','color','background','font','position'].forEach(function(name){setSubtitleStyle(name,subtitleStyle[name]);});
  function updateCaptions(){
    if(isNativeFullscreen&&currentSub!=='off'){captionO.classList.remove('show');return;}
    var entry=subtitleElements[currentSub];
    if(!entry||!entry.cues){captionO.classList.remove('show');return;}
    var t=video.currentTime-subtitleOffset,match=entry.cues.find(function(cue){return t>=cue.start&&t<=cue.end;});
    if(match){if(captionO.textContent!==match.text)captionO.textContent=match.text;captionO.classList.add('show');}else{captionO.classList.remove('show');}
  }
  // timeupdate only fires every ~265 ms, coarser than the 0.25 s sync step, so
  // captions landed up to a quarter second late and sync clicks looked like no-ops.
  // Redraw per video frame while a subtitle is on.
  var captionLoopOn=false;
  function nextCaptionTick(){if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(captionTick);else requestAnimationFrame(captionTick);}
  function captionTick(){if(video.paused||currentSub==='off'){captionLoopOn=false;return;}updateCaptions();nextCaptionTick();}
  function startCaptionLoop(){if(captionLoopOn||video.paused||currentSub==='off')return;captionLoopOn=true;nextCaptionTick();}
  video.addEventListener('play',startCaptionLoop);
  // iOS fullscreen draws the native <track> itself, which never saw the offset.
  function shiftNativeCues(){
    Object.keys(nativeSubtitleElements).forEach(function(code){
      var track=nativeSubtitleElements[code].track,cues=track&&track.cues,d=subtitleOffset-(track&&track._offset||0);
      if(!cues||!cues.length||!d)return;
      for(var i=0;i<cues.length;i++){cues[i].startTime+=d;cues[i].endTime+=d;}
      track._offset=subtitleOffset;
    });
  }
  var subtitleOffsetRange=document.getElementById('subtitleOffsetRange'),subtitleOffsetInput=document.getElementById('subtitleOffsetInput');
  subtitleOffsetInput.addEventListener('change',function(){applySubtitleOffset(subtitleOffsetInput.value);});
  subtitleOffsetInput.addEventListener('keydown',function(e){e.stopPropagation();});
  function applySubtitleOffset(value){
    subtitleOffset=Math.max(-30,Math.min(30,Number(value)||0));
    localStorage.setItem(subtitleOffsetKey,subtitleOffset.toFixed(2));
    updateCaptions();shiftNativeCues();
    subtitleOffsetRange.value=subtitleOffset;subtitleOffsetInput.value=subtitleOffset.toFixed(2).replace(/.?0+$/,'');
  }
  function setSubtitleOffset(delta){applySubtitleOffset(delta==='reset'?0:subtitleOffset+Number(delta));}
  subtitleOffsetRange.addEventListener('input',function(){applySubtitleOffset(subtitleOffsetRange.value);});
  // SRT uses a comma before the milliseconds; VTT uses a dot.
  function cueTime(value){var p=value.replace(',','.').split(':').map(Number);return p.length===3?p[0]*3600+p[1]*60+p[2]:p[0]*60+p[1];}
  function parseCues(text){
    var lines=text.replace(/\r/g,'').split('\n');
    var cues=[];
    for(var i=0;i<lines.length;i++){
      if(lines[i].indexOf('-->')<0)continue;
      var parts=lines[i].split('-->'),start=cueTime(parts[0].trim()),end=cueTime(parts[1].trim().split(/\s+/)[0]),cueLines=[],j=i+1;
      while(j<lines.length&&lines[j].trim()){cueLines.push(lines[j].replace(/<[^>]+>/g,''));j++;}
      if(isFinite(start)&&isFinite(end)&&cueLines.length)cues.push({start:start,end:end,text:cueLines.join('\n')});
    }
    return cues;
  }
  // Viewer's own subtitle file: parsed in the browser, never uploaded anywhere.
  var subtitleUploadBtn=document.getElementById('subtitleUploadBtn'),subtitleUploadInput=document.getElementById('subtitleUploadInput');
  subtitleUploadBtn.addEventListener('click',function(){subtitleUploadInput.click();});
  var localSubtitleName='';
  function loadLocalSubtitle(name,text){
      var cues=parseCues(String(text||''));
      if(!cues.length){subtitleUploadBtn.querySelector('span').textContent='No cues found in '+name;return false;}
      localSubtitleName=String(name||'Subtitle file');
      subtitleElements.local={cues:cues};
      var btn=subtitlesPanel.querySelector('[data-sub="local"]');
      if(!btn){btn=document.createElement('button');btn.className='panel-item';btn.dataset.sub='local';btn.innerHTML='<span class="row-label"><span class="flag">📄</span><span></span></span><svg class="check" viewBox="0 0 24 24"><path d="M9 16.2l-3.5-3.5L4 14.2 9 19l11-11-1.4-1.4z"/></svg>';subtitleLangList.insertBefore(btn,subtitleLangList.firstChild);btn.addEventListener('click',function(){selectSubtitle('local');closeAllPanels();});}
      btn.querySelector('.row-label span:last-child').textContent=localSubtitleName;
      subtitleUploadBtn.querySelector('span').textContent='Upload another file';
      selectSubtitle('local');
      return true;
  }
  subtitleUploadInput.addEventListener('change',function(){
    var file=subtitleUploadInput.files&&subtitleUploadInput.files[0];
    if(!file)return;
    var reader=new FileReader();
    reader.onload=function(){loadLocalSubtitle(file.name,reader.result);};
    reader.readAsText(file);
    subtitleUploadInput.value='';
  });
  // Lazy: called when a language is actually selected, not for all of them on
  // mount. Every subtitle used to be fetched TWICE at load (once by the <track
  // src> above, once here) — 10 languages x ~200KB x 2 = ~4MB of requests fired
  // while the player was still trying to get its first video segment, on the
  // same origin. Measured 67s of cumulative request time on a cold load.
  function loadSubtitle(item){
    if(!item||item._subLoading||subtitleElements[item.code])return;
    item._subLoading=true;
    // The native <track> is only ever read by iOS's fullscreen caption surface;
    // everywhere else the custom overlay renders from the parsed cues below, so
    // pointing it at the file would just fetch the same VTT a second time.
    var nativeTrack=nativeSubtitleElements[item.code];
    if(isIOSNativeVideo&&nativeTrack&&!nativeTrack.getAttribute('src')){nativeTrack.addEventListener('load',shiftNativeCues);nativeTrack.src=item.url;}
    fetch(item.url).then(function(r){if(!r.ok)throw new Error('unavailable');return r.text();}).then(function(text){
      subtitleElements[item.code]={cues:parseCues(text)};
      // Tracks were already attached up-front for iOS fullscreen support.
      if(currentSub===item.code){updateCaptions();syncNativeSubtitle();}
    }).catch(function(){item._subLoading=false;var btn=subtitlesPanel.querySelector('[data-sub="'+item.code+'"]');if(btn)btn.remove();if(currentSub===item.code)selectSubtitle('off');});
  }
  function syncNativeSubtitle(){
    Object.keys(nativeSubtitleElements).forEach(function(code){
      var track=nativeSubtitleElements[code];
      if(track&&track.track)track.track.mode=(isNativeFullscreen&&currentSub===code)?'showing':'hidden';
    });
  }
  applySubtitleOffset(subtitleOffset);
  var lastSubChoice=null;
  function selectSubtitle(value){
    if(value!=='off')lastSubChoice=value;
    subtitlesPanel.querySelectorAll('[data-sub]').forEach(function(b){b.classList.toggle('active',b.dataset.sub===value);});
    currentSub=value;
    if(value!=='off'){
      for(var si=0;si<subtitleTracks.length;si++){if(subtitleTracks[si].code===value){loadSubtitle(subtitleTracks[si]);break;}}
    }
    updateCaptions();startCaptionLoop();
    syncNativeSubtitle();
  }
  function saveSubLang(){try{localStorage.setItem('vidrift:sub-lang',currentSub);}catch(e){}}
  subtitlesPanel.querySelectorAll('[data-sub]').forEach(function(btn){btn.addEventListener('click',function(){selectSubtitle(btn.dataset.sub);saveSubLang();closeAllPanels();});});
  // The next episode opens in a fresh player; carry the chosen language into it.
  try{var savedSub=localStorage.getItem('vidrift:sub-lang');if(savedSub&&savedSub!=='off'&&subtitleTracks.some(function(t){return t.code===savedSub;}))selectSubtitle(savedSub);}catch(e){}
  subtitlesPanel.querySelectorAll('[data-offset]').forEach(function(btn){btn.addEventListener('click',function(){setSubtitleOffset(btn.dataset.offset);});});
  subtitleAppearance.querySelectorAll('button[data-style],.seg[data-style] button').forEach(function(btn){btn.addEventListener('click',function(){setSubtitleStyle(btn.dataset.style||btn.parentNode.dataset.style,btn.dataset.value);});});
  subtitleAppearance.querySelectorAll('input[data-style]').forEach(function(inp){inp.addEventListener('input',function(){setSubtitleStyle(inp.dataset.style,inp.type==='checkbox'?String(inp.checked):inp.value);});});
  document.getElementById('subtitleLangBack').addEventListener('click',backToSettings);
  subtitlesPanel.querySelectorAll('[data-subtitle-view]').forEach(function(btn){btn.addEventListener('click',function(){var view=btn.dataset.subtitleView;if(view==='languages'&&appearanceFrom==='settings'){backToSettings();return;}if(view==='appearance')appearanceFrom=null;subtitleLanguages.hidden=view!=='languages';subtitleAppearance.hidden=view==='languages';subtitlesPanel.scrollTop=0;});});

  // Speed
  // Settings tabs
  var userSelectedTab = false;
  function switchSettingsTab(tabName, isManual){
    if(isManual) userSelectedTab = true;
    settingsPanel.querySelectorAll('[data-settings-tab]').forEach(function(tab){
      tab.classList.toggle('active', tab.dataset.settingsTab === tabName);
    });
    document.getElementById('settingsHome').hidden = (tabName !== 'home');
    document.getElementById('settingsViewAudio').hidden = (tabName !== 'audio');
    document.getElementById('settingsViewQuality').hidden = (tabName !== 'quality');
    document.getElementById('settingsViewSpeed').hidden = (tabName !== 'speed');
    settingsPanel.scrollTop=0;
    if(tabName==='home')refreshSettingsTiles();
  }
  function refreshSettingsTiles(){
    var levels=playbackLevels(),curQ=selectedQuality()==='auto'?-1:Number(selectedQuality());
    document.getElementById('tileQuality').textContent=curQ>=0&&levels[curQ]?qualityLabel(levels[curQ]):(levels.length===1?qualityLabel(levels[0]):'Auto');
    var st=streams[currentSource];document.getElementById('tileServer').textContent=st?st.label:providerLabel(currentProvider);
    var track=null;for(var i=0;i<subtitleTracks.length;i++)if(subtitleTracks[i].code===currentSub)track=subtitleTracks[i];
    document.getElementById('tileSubtitles').textContent=currentSub==='off'?'Off':track?track.label:'File';
    document.getElementById('settingsSubToggle').checked=currentSub!=='off';
    var tracks=audioTracks(),active=currentAudioTrack();document.getElementById('tileAudio').textContent=tracks.length?audioLabel(tracks[active]||tracks[0],active).replace(/[<>&]/g,''):'Default';
  }
  settingsPanel.querySelectorAll('[data-open]').forEach(function(btn){btn.addEventListener('click',function(e){
    e.stopPropagation();var what=btn.dataset.open;closeAllPanels();
    if(what==='server'){serverFrom='settings';updateServerPanel();serverPanel.classList.add('show');return;}
    subsFrom='settings';appearanceFrom=null;syncSubsBack();
    subtitlesPanel.classList.add('show');subtitlesPanel.querySelector('[data-subtitle-view="'+(what==='subtitles'?'languages':'appearance')+'"]').click();
    if(what==='subtitle-settings')appearanceFrom='settings';
  });});
  document.getElementById('settingsSubToggle').addEventListener('change',function(){selectSubtitle(this.checked?(lastSubChoice||(subtitleTracks[0]&&subtitleTracks[0].code)||'off'):'off');saveSubLang();refreshSettingsTiles();});
  settingsPanel.querySelectorAll('[data-settings-tab]').forEach(function(tab){
    tab.addEventListener('click', function(e){
      e.stopPropagation();
      switchSettingsTab(tab.dataset.settingsTab, true);
    });
  });

  // Speed
  settingsPanel.querySelectorAll('[data-speed]').forEach(function(btn){
    btn.addEventListener('click',function(){
      settingsPanel.querySelectorAll('[data-speed]').forEach(function(b){b.classList.remove('active');});
      btn.classList.add('active');
      video.playbackRate=parseFloat(btn.dataset.speed);
      closeAllPanels();
    });
  });

  function qualityLabel(level){
    var h=Number(level&&level.height)||(typeof video!=='undefined'?video.videoHeight:0)||0;
    var w=Number(level&&level.width)||(typeof video!=='undefined'?video.videoWidth:0)||0;
    if(h>0){
      if(h>=850||w>=1900)return '1080p';
      if(h>=540||(w>=1200&&h>=450))return '720p';
      if(h>=400||(w>=700&&h>=380))return '480p';
      return '360p';
    }
    return w>=1900?'1080p':w>=1200?'720p':w>=700?'480p':'360p';
  }
  function qualityOptionsForMobile(){var levels=playbackLevels();if(levels.length<2)return [];return [{option:'quality',value:'auto',label:'Auto',group:'Quality'}].concat(levels.map(function(level,index){return {option:'quality',value:String(index),label:qualityLabel(level),group:'Quality'};}));}
  // The quality the UI should show is the one the viewer CHOSE. hls.currentLevel
  // is the level of the chunk at the playhead: it lags a nextLevel switch by up
  // to two 30 s groups and reads -1 mid-switch, which made the settings sheet
  // snap back to "Auto" right after a manual pick (Discord report, 2026-09-21).
  function selectedQuality(){
    return (hls&&hls.autoLevelEnabled===false&&typeof hls.loadLevel==='number'&&hls.loadLevel>=0)?String(hls.loadLevel):'auto';
  }
  function setQuality(value){
    if(hls){
      // hls.nextLevel, never hls.currentLevel: currentLevel is an IMMEDIATE
      // switch that aborts the in-flight chunk and flushes the WHOLE buffer
      // (measured 41.6 s -> 0 s on a manual 1080p pick, 2026-09-20), so the
      // viewer sits on a spinner until a full 30 s relay group lands at the
      // new level. nextLevel keeps the playing chunk + the next one and flushes
      // only beyond that. Re-applying 'Auto' at startup also threw away the
      // buffered first fragment (~1.5 s of first frame, 2026-09-19), so only
      // touch it when something actually changes.
      if(value==='auto'){if(!hls.autoLevelEnabled)hls.nextLevel=-1;}
      else{
        var index=Number(value);
        if(Number.isInteger(index)&&hls.levels[index]&&!(hls.autoLevelEnabled===false&&hls.loadLevel===index))hls.nextLevel=index;
      }
    }
    settingsPanel.querySelectorAll('[data-quality]').forEach(function(btn){
      btn.classList.toggle('active',btn.dataset.quality===String(value));
    });
    closeAllPanels();
  }
  function applyQualityPreference(label){
    if(!hls||!hls.levels||!hls.levels.length)return;
    if(!label||label==='Auto'){setQuality('auto');return;}
    var match=-1;
    hls.levels.forEach(function(level,index){if(qualityLabel(level)===label)match=index;});
    if(match>=0)setQuality(String(match));
    else setQuality('auto');
  }

  // --- Audio tracks -------------------------------------------------------
  // Orion's dubs are separate streams, not tracks inside one, so while Orion
  // plays they ARE the audio tracks: picking one goes through pickSource (keeps
  // the position, remembers the language). hls.js's own single-track index says
  // nothing about which dub is on, so the active one comes from currentSource.
  function orionDubs(){
    if(currentProvider!=='moviebox')return [];
    var out=[];streams.forEach(function(s,i){if(s.provider==='moviebox'&&s.label&&s.label.indexOf(' · ')>0)out.push({name:s.label.split(' · ')[1],idx:i});});
    return out.length>1?out:[];
  }
  function audioTracks(){var d=orionDubs();return d.length?d:((hls&&hls.audioTracks)||[]);}
  function audioLabel(track,index){return (track&&(track.name||track.lang))||('Track '+(index+1));}
  function currentAudioTrack(){
    var d=orionDubs();if(d.length){for(var j=0;j<d.length;j++)if(d[j].idx===currentSource)return j;return 0;}
    if(hls&&typeof hls.audioTrack==='number'&&hls.audioTrack>=0)return hls.audioTrack;
    var tracks=audioTracks();
    for(var i=0;i<tracks.length;i++){
      if(tracks[i]&&(tracks[i].default||tracks[i].url===(hls&&hls.url)))return i;
    }
    return 0;
  }
  function updateAudioTrackSelection(preferredIndex){
    var active=(!orionDubs().length&&typeof preferredIndex==='number'&&preferredIndex>=0)?preferredIndex:currentAudioTrack();
    settingsPanel.querySelectorAll('[data-audio]').forEach(function(btn){
      btn.classList.toggle('active',Number(btn.dataset.audio)===active);
    });
  }
  function setAudioTrack(value){
    var index=Number(value),d=orionDubs();
    if(d.length){closeAllPanels();if(d[index])pickSource(d[index].idx);return;}
    if(hls&&Number.isInteger(index)&&hls.audioTracks&&hls.audioTracks[index])hls.audioTrack=index;
    updateAudioTrackSelection(index);
    closeAllPanels();
  }
  function audioOptionsForMobile(){
    var tracks=audioTracks();if(tracks.length<2)return [];
    return tracks.map(function(track,index){return {option:'audio',value:String(index),label:audioLabel(track,index),group:'Audio'};});
  }
  function renderAudioOptions(){
    var tracks=audioTracks(),tab=document.getElementById('settingsTabAudio'),container=document.getElementById('audioOptions');
    if(!container)return;
    if(!tracks.length){container.innerHTML='<button class="panel-item active"><span>Default</span><svg class="check" viewBox="0 0 24 24"><path d="M9 16.2l-3.5-3.5-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></button>';return;}
    var active=currentAudioTrack();
    container.innerHTML=tracks.map(function(track,index){
      return '<button class="panel-item'+(index===active?' active':'')+'" data-audio="'+index+'"><span>'+audioLabel(track,index).replace(/[<>&]/g,'')+'</span><svg class="check" viewBox="0 0 24 24"><path d="M9 16.2l-3.5-3.5-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></button>';
    }).join('');
    container.querySelectorAll('[data-audio]').forEach(function(btn){
      btn.onclick=function(){setAudioTrack(btn.dataset.audio);};
    });
  }
  function playbackLevels(){if(hls&&hls.levels&&hls.levels.length)return hls.levels;return video.videoHeight?[{width:video.videoWidth,height:video.videoHeight}]:[];}
  function renderQualityOptions(){
    var levels=playbackLevels(),autoButton=settingsPanel.querySelector('[data-quality="auto"]'),header=document.getElementById('qualityHeader');
    var container=document.getElementById('qualityOptions');
    if(!container)return;
    if(autoButton)autoButton.onclick=function(){setQuality('auto');};
    var single=levels.length<2;
    if(header)header.textContent=single&&levels.length?'Quality — '+qualityLabel(levels[0]):'Quality';
    if(autoButton)autoButton.style.display=single?'none':'';
    container.innerHTML=single?'':levels.map(function(level,index){
      return '<button class="panel-item" data-quality="'+index+'"><span>'+qualityLabel(level)+'</span><svg class="check" viewBox="0 0 24 24"><path d="M9 16.2l-3.5-3.5-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></button>';
    }).join('');
    container.querySelectorAll('[data-quality]').forEach(function(btn){
      btn.onclick=function(){setQuality(btn.dataset.quality);};
    });
    var curQ=selectedQuality();
    settingsPanel.querySelectorAll('[data-quality]').forEach(function(btn){
      btn.classList.toggle('active',btn.dataset.quality===curQ);
    });
  }

  // Safari casts the video element directly; Chrome Cast must receive the real
  // stream URL because hls.js plays through a temporary blob: URL.
  video.setAttribute('x-webkit-airplay','allow');
  var castContext=null;
  function initGoogleCast(){
    if(!window.__vidriftCastAvailable||!window.cast||!cast.framework||!window.chrome||!chrome.cast)return;
    castContext=cast.framework.CastContext.getInstance();
    castContext.setOptions({receiverApplicationId:chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,autoJoinPolicy:chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED});
  }
  window.addEventListener('vidrift:cast-ready',initGoogleCast);
  initGoogleCast();
  castBtn.hidden=false;
  castBtn.addEventListener('click',function(){
    if(typeof video.webkitShowPlaybackTargetPicker==='function')video.webkitShowPlaybackTargetPicker();
    else if(castContext){
      var stream=streams[currentSource];
      if(!stream||!stream.url){alert('The stream is still loading. Try Cast again in a moment.');return;}
      castContext.requestSession().then(function(){
        var info=new chrome.cast.media.MediaInfo(stream.url,stream.type==='mp4'?'video/mp4':'application/x-mpegURL');
        var request=new chrome.cast.media.LoadRequest(info);
        request.autoplay=!video.paused;request.currentTime=video.currentTime||0;
        return castContext.getCurrentSession().loadMedia(request);
      }).catch(function(error){if(!error||error!=='cancel')alert('Cast could not connect. Make sure the TV and this device are on the same Wi-Fi.');});
    }else alert(/iPhone|iPad|iPod/.test(navigator.userAgent)?'On iPhone, open this page in Safari and use AirPlay.':'Casting is not available in this browser or device.');
  });

  // Fullscreen
  video.addEventListener('webkitbeginfullscreen',function(){isNativeFullscreen=true;syncNativeSubtitle();});
  video.addEventListener('webkitendfullscreen',function(){isNativeFullscreen=false;syncNativeSubtitle();updateCaptions();});
  // Chrome/Edge also define video.webkitEnterFullscreen (a legacy artifact, not an
  // iOS-only signal despite the name) but it silently no-ops on an hls.js/MSE-backed
  // video there, so the standard element.requestFullscreen() must be tried first —
  // it works everywhere except old iOS Safari, which is what webkitEnterFullscreen
  // is actually for.
  function toggleFullscreen(){
    if(document.fullscreenElement){document.exitFullscreen();return;}
    if(player.requestFullscreen){
      player.requestFullscreen().catch(function(){if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();});
    }else if(video.webkitEnterFullscreen){
      video.webkitEnterFullscreen();
    }
  }
  document.getElementById('fullscreenBtn').addEventListener('click',toggleFullscreen);

  var pipBtn=document.getElementById('pipBtn');
  function togglePip(){
    try{
      if(document.pictureInPictureElement)document.exitPictureInPicture();
      else if(video.requestPictureInPicture)video.requestPictureInPicture().catch(function(){});
    }catch(e){}
  }
  if(document.pictureInPictureEnabled&&video.requestPictureInPicture&&!isIOSNativeVideo){
    pipBtn.hidden=false;
    pipBtn.addEventListener('click',togglePip);
  }

  // The title card is worth showing only where the viewer has no other
  // context — in a small embed the control bar already carries the label.
  function syncFsClass(){
    var on=!!(document.fullscreenElement||document.webkitFullscreenElement);
    player.classList.toggle('is-fs',on);
    // Phones held upright letterbox a 16:9 film to phone width; turn it sideways
    // like other players do. Android only -- desktop rejects the lock and iOS
    // uses its own fullscreen player, which rotates by itself.
    try{
      if(on&&screen.orientation&&screen.orientation.lock&&!(video.videoHeight>video.videoWidth))screen.orientation.lock('landscape').catch(function(){});
      else if(!on&&screen.orientation&&screen.orientation.unlock)screen.orientation.unlock();
    }catch(e){}
    showC();
  }
  document.addEventListener('fullscreenchange',syncFsClass);
  document.addEventListener('webkitfullscreenchange',syncFsClass);

  // Auto-hide
  // The bar used to vanish 2.8s after the last mousemove even while the
  // pointer was resting on it — reach for the volume slider, lose the volume
  // slider. Hovering the controls now pins them open.
  // Touch device outside fullscreen: the bar never auto-hides. Also guards the
  // mouseleave below, which iOS fires as a synthetic mouse event after a tap.
  // 2026-09-20 evening: auto-hide is back on phones now that the centre
  // cluster exists; a tap brings the bar up. Kept as a switch.
  function pinnedControls(){return false;}
  function showC(){
    var pr=document.getElementById('preroll');
    if(player.classList.contains('is-prerolling')||(pr&&!pr.classList.contains('hide')))return;
    if(!player.classList.contains('controls-visible'))player.classList.add('controls-visible');
    clearTimeout(hideTimer);
    // Touch device, not fullscreen: the bar stays on screen. It only auto-hides
    // once the viewer has gone fullscreen (2026-09-19).
    if(!video.paused&&!player.classList.contains('hold-controls')&&!pinnedControls())
      hideTimer=setTimeout(function(){player.classList.remove('controls-visible');closeAllPanels();},2800);
  }
  document.querySelectorAll('.bottom-bar,.top-actions').forEach(function(bar){
    bar.addEventListener('pointerenter',function(){player.classList.add('hold-controls');clearTimeout(hideTimer);});
    bar.addEventListener('pointerleave',function(){player.classList.remove('hold-controls');showC();});
  });
  player.addEventListener('mousemove',showC);
  player.addEventListener('touchstart',showC,{passive:true});
  video.addEventListener('playing',showC);
  video.addEventListener('playing',postProviders);
  // Belt and braces for phones: whatever path drops the class (iOS synthetic
  // mouse events, a panel close, a late timer), put it back while playing
  // outside fullscreen. Cheap: one classList check a second.
  setInterval(function(){
    if(!pinnedControls()||video.paused||player.classList.contains('is-prerolling'))return;
    var pr=document.getElementById('preroll');
    if(pr&&!pr.classList.contains('hide'))return;
    if(!player.classList.contains('controls-visible'))player.classList.add('controls-visible');
  },1000);
  // The parent page can float its own buttons over this frame (7movies' back button and
  // source pickers on desktop). Moving onto one is a mouseleave here, which used to hide the
  // controls at once. Now leaving waits a beat, and the parent holds the controls open while
  // its pointer is on that overlay ('vidrift:hold-controls', 2026-09-25).
  var leaveTimer=null;
  player.addEventListener('mouseleave',function(){clearTimeout(leaveTimer);leaveTimer=setTimeout(function(){if(!video.paused&&!pinnedControls()&&!player.classList.contains('hold-controls'))player.classList.remove('controls-visible');},200);});
  player.addEventListener('mouseenter',function(){clearTimeout(leaveTimer);});
  window.addEventListener('message',function(e){var d=e.data||{};if(e.source!==window.parent||d.type!=='vidrift:hold-controls')return;clearTimeout(leaveTimer);player.classList.toggle('hold-controls',!!d.hold);showC();});
  showC();

  // Loading — debounce to avoid flash on seek/start
  var waitTimer=null;
  video.addEventListener('waiting',function(){clearTimeout(waitTimer);waitTimer=setTimeout(function(){if(!document.getElementById('preroll').classList.contains('hide'))return;player.classList.add('loading');loader.classList.add('show');},800);});
  video.addEventListener('canplay',function(){clearTimeout(waitTimer);player.classList.remove('loading');loader.classList.remove('show');});
  video.addEventListener('playing',function(){clearTimeout(waitTimer);player.classList.remove('loading');loader.classList.remove('show');if(!telemetrySent.first){telemetrySent.first=true;sendTelemetry('first_frame',{ms:Math.round(performance.now())});}});
  video.addEventListener('ended',function(){
    try{ window.parent.postMessage({type:'vidrift:ended',tmdbId:embedMeta.tmdbId,mediaType:embedMeta.type,season:embedMeta.season,episode:embedMeta.episode},'*'); }catch(e){}
  });
  var nextUpSent=false;
  video.addEventListener('timeupdate',function(){
    if(!nextUpSent&&video.duration>0&&video.duration-video.currentTime<=30){
      nextUpSent=true;showNextUp();
      try{ window.parent.postMessage({type:'vidrift:nextup',tmdbId:embedMeta.tmdbId,mediaType:embedMeta.type,season:embedMeta.season,episode:embedMeta.episode},'*'); }catch(e){}
    }
  });

  // Keyboard
  function nudgeVolume(delta){
    // Base on the real level, not on muted-as-zero: playback starts muted for
    // autoplay, so treating that as 0 made the first volume-up press DROP the
    // level to 5% instead of unmuting at what the viewer had set.
    var v=Math.min(1,Math.max(0,video.volume+delta));
    video.volume=v;
    if(delta>0&&v>0)video.muted=false;
    if(v===0)video.muted=true;
    wantSound=!video.muted;
    volFill.style.width=(v*100)+'%';updateVolIcon();
    try{localStorage.setItem(volKey,String(v));}catch(e){}saveMuted();
  }
  function toggleCaptions(){
    var target=currentSub==='off'?(subtitleTracks[0]&&subtitleTracks[0].code):'off';
    if(!target)return;
    var btn=subtitlesPanel.querySelector('[data-sub="'+target+'"]');
    if(btn)btn.click();
  }
  // Arrows seek 10s, matching the skip buttons — they used to seek 5s, so the
  // same intent gave two different answers depending on how you asked.
  document.addEventListener('keydown',function(e){
    if(e.metaKey||e.ctrlKey||e.altKey)return;
    // Escape closes a menu. After a tap focus sits in this frame, so the parent's
    // phone sheet is told too.
    if(e.key==='Escape'){closeAllPanels();if(parentMobileSheets){try{window.parent.postMessage({type:'vidrift:close-sheet'},'*');}catch(err){}}return;}
    var handled=['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyF','KeyM','KeyK','KeyJ','KeyL','KeyC','KeyP','Home','End'];
    if(handled.indexOf(e.code)>=0||e.key===' '||/^Digit[0-9]$/.test(e.code))e.preventDefault();
    if(e.code==='Space'||e.code==='KeyK')togglePlay();
    else if(e.code==='ArrowLeft'||e.code==='KeyJ')video.currentTime=Math.max(0,video.currentTime-10);
    else if(e.code==='ArrowRight'||e.code==='KeyL')video.currentTime=Math.min(video.duration||0,video.currentTime+10);
    else if(e.code==='ArrowUp')nudgeVolume(0.05);
    else if(e.code==='ArrowDown')nudgeVolume(-0.05);
    else if(e.code==='Home')video.currentTime=0;
    else if(e.code==='End'&&isFinite(video.duration))video.currentTime=Math.max(0,video.duration-1);
    else if(e.code==='KeyF')toggleFullscreen();
    else if(e.code==='KeyM')document.getElementById('muteBtn').click();
    else if(e.code==='KeyC')toggleCaptions();
    else if(e.code==='KeyP'&&!pipBtn.hidden)togglePip();
    else if(/^Digit[0-9]$/.test(e.code)&&isFinite(video.duration)&&video.duration>0)
      video.currentTime=(Number(e.code.slice(5))/10)*video.duration;
    showC();
  });

  // A mouse click leaves the control focused, so the NEXT keypress -- Space to
  // pause, M, F, an arrow -- promotes it to :focus-visible and paints the brand
  // ring around whichever button you last touched (reported on the fullscreen
  // button, but every .ctrl-btn had it). Drop focus after POINTER clicks only:
  // e.detail is 0 for keyboard activation, so someone tabbing to a control keeps
  // their focus ring and their place in the tab order. Safe against the panels --
  // they are class-driven (closeAllPanels) with no focusout handler, so losing
  // focus cannot close one.
  document.addEventListener('click',function(e){
    var btn=e.target&&e.target.closest?e.target.closest('.ctrl-btn'):null;
    if(btn&&e.detail>0)btn.blur();
  });

  var providerCursor=0;
  var providerLoadGeneration=0; // invalidates stale provider responses after a switch
  function providerLabel(provider){return provider==='evion'?'Evion':provider==='moviebox'?'Orion':provider==='vaplayer'?'Earth':provider==='vidlove'?'Star':provider==='vidgod'?'Prime':provider==='turbo'?'Turbo':provider==='selfhost'?'Direct':provider==='cinepro'?'Cine':provider==='flax'?'Comet':provider==='vidrock'?'Atlas':provider;}
  function sourceTypePath(){return embedMeta.type==='tv'?'tv/'+embedMeta.tmdbId+'/'+embedMeta.season+'/'+embedMeta.episode:'movie/'+embedMeta.tmdbId;}
  function probeMediaBytes(buffer){
    if(!buffer||buffer.byteLength<4)return false;
    var bytes=new Uint8Array(buffer),text='';
    for(var i=0;i<Math.min(bytes.length,64);i++)text+=String.fromCharCode(bytes[i]);
    return bytes[0]===0x47||text.indexOf('ftyp')>=0;
  }
  function probeHlsPlaylist(url,depth,signal){
    if(depth>2)return Promise.resolve(false);
    return fetch(url,{cache:'no-store',signal:signal}).then(function(response){
      if(!response.ok)return false;
      function follow(buffer){
        if(probeMediaBytes(buffer))return true;
        var text=new TextDecoder().decode(buffer);
        if(!text.includes('#EXTM3U'))return false;
        var lines=text.split(/\r?\n/).map(function(line){return line.trim();}).filter(function(line){return line&&!line.startsWith('#')&&!line.startsWith('//');});
        return lines.length?probeHlsPlaylist(lines[0],depth+1,signal):false;
      }
      if(!response.body)return response.arrayBuffer().then(follow);
      var reader=response.body.getReader(),chunks=[],length=0,head=[];
      function read(){return reader.read().then(function(part){
        if(part.done){var buffer=new Uint8Array(length),offset=0;chunks.forEach(function(chunk){buffer.set(chunk,offset);offset+=chunk.byteLength;});return follow(buffer);}
        for(var i=0;i<part.value.byteLength&&head.length<64;i++)head.push(part.value[i]);
        if(probeMediaBytes(new Uint8Array(head))){reader.cancel();return true;}
        chunks.push(part.value);length+=part.value.byteLength;return read();
      });}
      return read();
    }).catch(function(){return false;});
  }
  function probeEarthSource(url){
    var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},5000);
    return probeHlsPlaylist(url,0,controller.signal).finally(function(){clearTimeout(timer);});
  }
  // The Earth race is disabled (2026-09-06). Confirmed on a production trace
  // (embed.vidrift.in, Silo S1E3): 3 master fetches plus 3 probe requests that
  // are aborted after the 8 KB head read (0 bytes transferred, ~5s occupied)
  // before hls.js starts, and hls.js then refetches everything from zero.
  //   * all 3 stream_urls resolve to ONE host (15 demand titles checked, none
  //     had more than one) and their first segments are byte-identical, so
  //     there is no CDN and no quality to select between. The "winner" was
  //     whichever of three equivalent URLs answered first.
  //   * a dead source is handled faster already: Hls.Events.ERROR with d.fatal
  //     calls failoverSource() immediately.
  //   * local A/B: 16 -> 7 proxy requests, 2.60 MB -> 1.27 MB per cold start.
  // Extra URLs stay as ordinary failover candidates; we just stop probing them.
  function orderPlayableEarthSources(items){
    return Promise.resolve(items);
  }
  function loadProviderAt(index){
    if(index<0||index>=providers.length){
      sourceSwitching=false;
      if(finishPreroll)finishPreroll();
      player.classList.remove('loading');loader.classList.remove('show');
      setLoaderStatus('Internal sources unavailable — switching to CinemaOS…');
      try{ window.parent.postMessage({type:'vidrift:external-fallback',provider:'cinemaos',tmdbId:embedMeta.tmdbId,mediaType:embedMeta.type,season:embedMeta.season,episode:embedMeta.episode,currentTime:video.currentTime||0},'*'); }catch(e){}
      // The postMessage above is the only signal an embedder gets, and almost
      // none listen for it. Without this the viewer is left staring at a black
      // rectangle with no way to retry.
      //
      // Exhausting the cascade once is usually a transient upstream timeout,
      // not a dead title — replay the whole thing once before declaring
      // failure, so a blip costs a few seconds instead of an error card.
      if(!fatalAutoRetried){
        fatalAutoRetried=true;
        setStage('Sources busy — retrying',60);pFoot.textContent='Retrying every source once more';
        prerollRetryPass=true;
        setTimeout(function(){if(!streamReady)retryPlayback();},1200);
        return;
      }
      showFatal();
      return;
    }
    providerCursor=index;
    currentProvider=providers[index];
    postProviders();
    sourceSwitching=true;
    var loadGeneration=++providerLoadGeneration;
    var label=providerLabel(currentProvider);
    setStage('Contacting '+label,35);pFoot.textContent='Looking for '+label+' sources…';
    var bakedUrl=currentProvider==='selfhost'?embedMeta.selfhostUrl:currentProvider==='evion'?embedMeta.evionUrl:'';
    if (bakedUrl) {
      // Direct HLS fast-path: the manifest URL was baked into the page at render
      // time (and preloaded in <head>), so skip the /api/source round trip — the
      // player jumps straight to the manifest + first segment.
      sourceSwitching=false;
      streams=[{index:0,provider:currentProvider,pIdx:0,type:(currentProvider==='selfhost'?embedMeta.selfhostKind==='mp4':bakedUrl.indexOf('.m3u8')<0)?'mp4':'hls',label:label+' 1',url:bakedUrl}];
      attemptedSources={};prerollStates={};currentSource=0;
      setStage('Loading '+label+' 1',70);pFoot.textContent='Trying '+label+' 1 of 1';
      renderPrerollRail(0);updateServerPanel();loadStream(0,true);
      return;
    }
    // Use the streams baked into the page by the server (see warmStreams) and
    // skip the /api/source round trip. ONE-SHOT: consumed once, so a retry, an
    // episode change or a provider switch always re-resolves for real. These
    // URLs are what /api/source would have handed back anyway, so a stream that
    // fails here would have failed identically via the fetch -- the existing
    // failover below is unchanged.
    var bakedFresh=Date.now()-pageBornAt<3600000;
    var warm=(bakedFresh&&currentProvider==='vaplayer'&&!warmStreamsUsed&&embedMeta.warmStreams&&embedMeta.warmStreams.length)?embedMeta.warmStreams:null;
    if(warm)warmStreamsUsed=true;
    // Orion's list, baked the same way on a lookup-cache hit (orionWarm). One-shot too.
    if(!warm&&bakedFresh&&currentProvider==='moviebox'&&embedMeta.orionStreams&&embedMeta.orionStreams.length){warm=embedMeta.orionStreams;embedMeta.orionStreams=null;}
    var lookupAt=performance.now();
    // Capped at 25 s: a source whose lookup hangs used to spin forever and never reach Earth (2026-09-25).
    (warm?Promise.resolve({streams:warm}):Promise.race([fetch('/api/source/'+sourceTypePath()+'?token='+encodeURIComponent(embedMeta.playbackToken)+'&provider='+encodeURIComponent(currentProvider)).then(function(r){return r.ok?r.json():null;}),new Promise(function(r){setTimeout(function(){r(null);},25000);})]))
      .then(function(data){
        if(loadGeneration!==providerLoadGeneration)return;
        sourceSwitching=false;
        if(!data||!Array.isArray(data.streams)||!data.streams.length){sendTelemetry('source_failed',{reason:'no-streams',ms:Math.round(performance.now()-lookupAt)});providerStates[currentProvider]='failed';renderPrerollRail(currentSource);loadProviderAt(index+1);return;}
        // The server raced the rest of the cascade for us: jump to that provider.
        if(data.fellBack&&data.provider&&data.provider!==currentProvider&&providers.indexOf(data.provider)>index){
          for(var k=index;k<providers.indexOf(data.provider);k++)providerStates[providers[k]]='failed';
          index=providers.indexOf(data.provider);providerCursor=index;currentProvider=data.provider;label=providerLabel(currentProvider);postProviders();
        }
        streams=data.streams.map(function(s,i){return{index:i,provider:currentProvider,pIdx:i,type:s.type||'hls',label:s.name||label+' '+(i+1),url:(s.url||s.proxyUrl)};});
        var orderPromise=currentProvider==='vaplayer'?orderPlayableEarthSources(streams):Promise.resolve(streams);
        setStage('Loading '+label,55);
        pFoot.textContent='Trying '+label+'…';
        return orderPromise.then(function(orderedStreams){
          streams=orderedStreams;
        attemptedSources={};prerollStates={};
        // Boot at the remembered source: global majority memory (embedMeta.source) first,
        // per-browser localStorage layered on top, fall back to 0. Was hardcoded to 0
        // (memory was write-only) — fixed 2026-08-05.
        var preferred = (currentProvider==='vaplayer'||currentProvider==='moviebox') ? 0 : (Number(embedMeta.source) || 0);
        var local = currentProvider==='vaplayer' ? -1 : currentProvider==='moviebox' ? orionDubIndex() : preferredSource(streams.length);
        if (local >= 0) preferred = local;
        if (!(preferred >= 0 && preferred < streams.length)) preferred = 0;
        currentSource = preferred;
        setStage('Loading '+streams[currentSource].label,70);pFoot.textContent='Trying '+streams[currentSource].label+' of '+streams.length;
        renderPrerollRail(currentSource);updateServerPanel();loadStream(currentSource,true);
        });
      }).catch(function(){
        if(loadGeneration!==providerLoadGeneration)return;
        sourceSwitching=false;loadProviderAt(index+1);
      });
  }
  function loadNextProvider(){
    providerStates[currentProvider]='failed';
    var next=providerCursor+1;
    if(next>=providers.length){loadProviderAt(next);return;}
    var label=providerLabel(providers[next]);
    setLoaderStatus(providerLabel(currentProvider)+' unavailable — trying '+label+'…');
    setStage('Trying '+label,55);pFoot.textContent='All '+providerLabel(currentProvider)+' sources failed — contacting '+label;
    loadProviderAt(next);
  }
  // Reached only once every provider, and every source under each of them,
  // has failed. Anything short of that keeps failing over silently.
  var fatalEl=document.getElementById('fatal');
  var fatalAutoRetried=false;
  var fatalDeferred=false;
  function showFatal(detail){
    // Mirrors the deferral below: a hidden tab has not really failed yet.
    if(!(document.hidden&&!fatalDeferred)&&!telemetrySent.failed){telemetrySent.failed=true;sendTelemetry('play_failed',{reason:String(detail||'all sources failed').slice(0,120)});}
    // Same reasoning as the watchdogs: a hidden tab never got a fair attempt,
    // so retry once when the viewer actually comes back rather than greeting
    // them with an error for something the browser throttled.
    if(document.hidden&&!fatalDeferred){
      fatalDeferred=true;
      document.addEventListener('visibilitychange',function onVis(){
        if(document.hidden)return;
        document.removeEventListener('visibilitychange',onVis);
        retryPlayback();
      });
      return;
    }
    // The provider cascade can run to exhaustion while a stream that already
    // loaded is still perfectly playable — a mid-playback hiccup kicks off
    // failover, every remaining source is tried, and we arrive here with
    // working video on screen. Never cover that with an error.
    if(streamReady&&video.readyState>=2&&!video.error)return;
    // A dead token 403s every source: swap it once and run the cascade again (see refreshExpiredToken).
    var tokExp=tokenExpMs(appliedPlaybackToken);
    if(tokExp&&tokExp<Date.now()&&!tokenRefreshTried){refreshExpiredToken().then(function(ok){if(ok)retryPlayback();else showFatal(detail);});return;}
    if(prerollRAF){cancelAnimationFrame(prerollRAF);prerollRAF=null;}
    prerollTimers.forEach(clearTimeout);prerollTimers=[];
    finishPreroll=null;
    player.classList.remove('loading');loader.classList.remove('show');
    player.classList.remove('is-prerolling');
    document.getElementById('preroll').classList.add('hide');
    if(detail)document.getElementById('fatalDetail').textContent=detail;
    document.getElementById('fatalNote').textContent=embedMeta.type==='tv'
      ? 'TMDB '+embedMeta.tmdbId+' · S'+(embedMeta.season||1)+'E'+(embedMeta.episode||1)
      : 'TMDB '+embedMeta.tmdbId;
    fatalEl.classList.add('show');
  }
  function retryPlayback(){
    fatalEl.classList.remove('show');
    providerCursor=0;
    currentProvider=embedMeta.provider||providers[0];
    streams=[];attemptedSources={};prerollStates={};providerStates={};
    currentSource=0;streamReady=false;sourceSwitching=false;
    document.getElementById('preroll').classList.remove('hide');
    updateServerPanel();
    loadInitialStreams();
  }
  document.getElementById('fatalRetry').addEventListener('click',retryPlayback);
  document.getElementById('fatalReload').addEventListener('click',function(){location.reload();});

  function loadInitialStreams(){
    // Honor an active ?provider=; unknown providers fall back to vaplayer (index 0).
    var startIdx = providers.indexOf(currentProvider);
    if (startIdx < 0) startIdx = 0;
    runPreroll('Searching ' + providerLabel(providers[startIdx]) + ' servers');
    pFoot.textContent = 'Contacting ' + providerLabel(providers[startIdx]) + '…';
    loadProviderAt(startIdx);
  }
  updateServerPanel();
  loadInitialStreams();
})();