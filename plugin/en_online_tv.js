(function () {
  'use strict';

  var PLUGIN_ID = 'en_online_tv';
  var VERSION = '0.3.0-tv';
  var DEFAULT_MIRRORS_URL = ''; // Built-in hosts work without a mirrors service.
  var MIRRORS_CACHE_KEY = PLUGIN_ID + '_mirrors';
  var MIRRORS_TTL_MS = 6 * 60 * 60 * 1000;
  var HOST_CACHE_KEY = PLUGIN_ID + '_hosts';
  var HOST_TTL_MS = 60 * 60 * 1000;

  var providers = [];
  var network = new Lampa.Reguest();

  function registerProvider(provider) {
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].name === provider.name) { providers[i] = provider; return; }
    }
    providers.push(provider);
  }

  function storageField(name, fallback) {
    var value = Lampa.Storage.get(PLUGIN_ID + '_' + name, '');
    return value === '' || value === null || value === undefined ? fallback : value;
  }

  function mirrorsUrl() {
    return storageField('mirrors_url', DEFAULT_MIRRORS_URL);
  }

  function proxyUrl() {
    return storageField('proxy_url', '');
  }

  function withProxy(url) {
    var proxy = proxyUrl();
    var helper = storageField('helper_url', window.EnOnlineTVHelper || '');
    if (!proxy && helper && /^https:\/\/vixsrc\.to\//.test(url)) return helper.replace(/\/+$/, '') + '/api/' + url;
    if (!proxy) return url;
    return proxy.replace(/\/?$/, '/') + url;
  }

  function now() {
    return new Date().getTime();
  }

  function loadMirrors(onReady) {
    var cached = Lampa.Storage.get(MIRRORS_CACHE_KEY, {});
    if (cached && cached.fetchedAt && now() - cached.fetchedAt < MIRRORS_TTL_MS && cached.sites) {
      onReady(cached.sites);
      return;
    }
    if (!mirrorsUrl()) return onReady(cached && cached.sites ? cached.sites : {});
    network.clear();
    network.timeout(10000);
    network.silent(mirrorsUrl(), function (json) {
      var sites = json && json.sites ? json.sites : {};
      Lampa.Storage.set(MIRRORS_CACHE_KEY, { fetchedAt: now(), sites: sites });
      onReady(sites);
    }, function () {
      onReady(cached && cached.sites ? cached.sites : {});
    });
  }

  function candidateHosts(provider, sites) {
    var fromMirrors = sites[provider.site] && sites[provider.site].hosts ? sites[provider.site].hosts : [];
    var fallback = provider.hosts || [];
    var merged = [];
    fromMirrors.concat(fallback).forEach(function (host) {
      var normalized = host.replace(/\/+$/, '');
      if (merged.indexOf(normalized) === -1) merged.push(normalized);
    });
    return merged;
  }

  function cachedHost(provider) {
    var cache = Lampa.Storage.get(HOST_CACHE_KEY, {}) || {};
    var entry = cache[provider.name];
    return entry && now() - entry.checkedAt < HOST_TTL_MS ? entry.host : '';
  }

  function rememberHost(provider, host) {
    var cache = Lampa.Storage.get(HOST_CACHE_KEY, {}) || {};
    cache[provider.name] = { host: host, checkedAt: now() };
    Lampa.Storage.set(HOST_CACHE_KEY, cache);
  }

  function mediaRequest(movie, season, episode) {
    var isSeries = !!(movie.name || movie.original_name || movie.number_of_seasons);
    return {
      tmdbId: movie.id,
      imdbId: movie.imdb_id || (movie.external_ids && movie.external_ids.imdb_id) || '',
      type: isSeries ? 'tv' : 'movie',
      title: movie.title || movie.name || '',
      originalTitle: movie.original_title || movie.original_name || '',
      year: parseInt((movie.release_date || movie.first_air_date || '0000').slice(0, 4), 10),
      season: season || 0,
      episode: episode || 0
    };
  }

  function playStreams(request, streams) {
    var displayTitle = request.title + (request.type === 'tv' ? ' S' + request.season + 'E' + request.episode : '');
    if (streams.length === 1) return startPlayer(displayTitle, streams[0]);
    Lampa.Select.show({
      title: displayTitle,
      items: streams.map(function (stream) {
        return { title: stream.label, subtitle: stream.info || '', stream: stream };
      }),
      onSelect: function (item) {
        startPlayer(displayTitle, item.stream);
      },
      onBack: backToCard
    });
  }

  function mediaUrl(url) {
    var prefix = storageField('media_proxy_url', '');
    return prefix && url ? prefix.replace(/\/?$/, '/') + url : url;
  }

  function startPlayer(displayTitle, stream) {
    var qualities = false;
    if (stream.qualities) {
      qualities = {};
      Object.keys(stream.qualities).forEach(function (key) { qualities[key] = mediaUrl(stream.qualities[key]); });
    }
    var subtitles = stream.subtitles ? stream.subtitles.map(function (sub) {
      return { label: sub.label, url: mediaUrl(sub.url) };
    }) : false;
    var video = {
      title: displayTitle,
      url: mediaUrl(stream.url),
      quality: qualities,
      subtitles: subtitles
    };
    Lampa.Player.play(video);
    Lampa.Player.playlist([video]);
  }

  function backToCard() {
    Lampa.Controller.toggle('full_start');
  }

  function resolveWith(provider, request, sites) {
    var requestNetwork = new Lampa.Reguest();
    var cancelled = false;
    var hosts = candidateHosts(provider, sites);
    var remembered = cachedHost(provider);
    if (remembered && hosts.indexOf(remembered) >= 0) {
      hosts.splice(hosts.indexOf(remembered), 1);
      hosts.unshift(remembered);
    }
    var index = 0;
    var lastError = 'No working source';
    Lampa.Loading.start(function () {
      cancelled = true;
      requestNetwork.clear();
      Lampa.Loading.stop();
    });
    function next() {
      if (cancelled) return;
      if (index >= hosts.length) {
        Lampa.Loading.stop();
        Lampa.Noty.show(provider.title + ': ' + lastError);
        return;
      }
      var host = hosts[index++];
      var settled = false;
      function fail(reason) {
        if (settled || cancelled) return;
        settled = true;
        lastError = reason || 'Nothing found';
        next();
      }
      try {
        provider.resolve({ host: host, request: request, network: requestNetwork, withProxy: withProxy }, function (streams) {
          if (settled || cancelled) return;
          streams = (streams || []).filter(function (stream) {
            return stream && /^https?:\/\//i.test(stream.url || '');
          });
          if (!streams.length) return fail('Nothing found');
          settled = true;
          rememberHost(provider, host);
          Lampa.Loading.stop();
          playStreams(request, streams);
        }, fail);
      } catch (error) { fail('Invalid source response'); }
    }
    next();
  }

  function chooseEpisode(movie, onChosen) {
    var seasons = (movie.seasons || []).filter(function (season) {
      return season.season_number > 0 && season.episode_count > 0;
    });
    if (!seasons.length) return Lampa.Noty.show('No seasons info');
    Lampa.Select.show({
      title: 'Season',
      items: seasons.map(function (season) {
        return { title: season.name || 'Season ' + season.season_number, subtitle: season.episode_count + ' ep.', season: season };
      }),
      onSelect: function (seasonItem) {
        var episodes = [];
        for (var number = 1; number <= seasonItem.season.episode_count; number++) {
          episodes.push({ title: 'Episode ' + number, episode: number });
        }
        Lampa.Select.show({
          title: seasonItem.title,
          items: episodes,
          onSelect: function (episodeItem) {
            onChosen(seasonItem.season.season_number, episodeItem.episode);
          },
          onBack: backToCard
        });
      },
      onBack: backToCard
    });
  }

  function openProviderMenu(movie) {
    if (!providers.length) return Lampa.Noty.show('No providers registered');
    loadMirrors(function (sites) {
      Lampa.Select.show({
        title: 'EN Online TV',
        items: providers.map(function (provider) {
          return { title: provider.title, subtitle: provider.site || '', provider: provider };
        }),
        onSelect: function (item) {
          var probeRequest = mediaRequest(movie);
          if (probeRequest.type === 'tv') {
            chooseEpisode(movie, function (season, episode) {
              resolveWith(item.provider, mediaRequest(movie, season, episode), sites);
            });
          } else {
            resolveWith(item.provider, probeRequest, sites);
          }
        },
        onBack: backToCard
      });
    });
  }

  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addComponent({
      component: PLUGIN_ID,
      name: 'EN Online TV',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    });
    Lampa.SettingsApi.addParam({
      component: PLUGIN_ID,
      param: { name: PLUGIN_ID + '_mirrors_url', type: 'input', values: '', default: '' },
      field: { name: 'Mirrors JSON URL', description: 'Empty = ' + DEFAULT_MIRRORS_URL }
    });
    Lampa.SettingsApi.addParam({
      component: PLUGIN_ID,
      param: { name: PLUGIN_ID + '_helper_url', type: 'input', values: '', default: '' },
      field: { name: 'TV helper URL', description: 'Local Mac helper address; automatically set when installed from the helper' }
    });
    Lampa.SettingsApi.addParam({
      component: PLUGIN_ID,
      param: { name: PLUGIN_ID + '_proxy_url', type: 'input', values: '', default: '' },
      field: { name: 'API proxy', description: 'Optional URL prefix for API and embed requests' }
    });
    Lampa.SettingsApi.addParam({
      component: PLUGIN_ID,
      param: { name: PLUGIN_ID + '_media_proxy_url', type: 'input', values: '', default: '' },
      field: { name: 'HLS proxy', description: 'Must rewrite nested playlists, segments, keys and subtitle URLs; a simple CORS proxy is insufficient' }
    });
    Lampa.SettingsApi.addParam({
      component: PLUGIN_ID,
      param: { name: PLUGIN_ID + '_reset_cache', type: 'trigger', default: false },
      field: { name: 'Reset mirrors cache' },
      onChange: function () {
        Lampa.Storage.set(MIRRORS_CACHE_KEY, {});
        Lampa.Storage.set(HOST_CACHE_KEY, {});
        Lampa.Noty.show('Cache cleared');
      }
    });
  }

  function addCardButton() {
    var buttonHtml = '<div class="full-start__button selector view--' + PLUGIN_ID + '">' +
      '<svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M8 5v14l11-7z"/></svg>' +
      '<span>EN Online TV</span></div>';
    Lampa.Listener.follow('full', function (event) {
      if (event.type !== 'complite') return;
      var button = $(buttonHtml);
      button.on('hover:enter', function () {
        openProviderMenu(event.data.movie);
      });
      event.object.activity.render().find('.view--torrent').after(button);
    });
  }

  function start() {
    if (window[PLUGIN_ID + '_ready']) return;
    window[PLUGIN_ID + '_ready'] = true;
    addSettings();
    addCardButton();
  }

  function absoluteUrl(host, url) {
    if (!url) return '';
    if (/^https?:\/\//.test(url)) return url;
    if (url.indexOf('//') === 0) return 'https:' + url;
    return host + (url.charAt(0) === '/' ? '' : '/') + url;
  }

  function vidriftBootPath(request) {
    var query = '?type=' + request.type + '&id=' + request.tmdbId + '&source=0&provider=&shell=1';
    if (request.type === 'tv') {
      return '/api/boot/tv/' + request.tmdbId + '/' + request.season + '/' + request.episode + query + '&season=' + request.season + '&episode=' + request.episode;
    }
    return '/api/boot/movie/' + request.tmdbId + query;
  }

  function vidriftSourcePath(request, playbackToken) {
    var mediaPath = request.type === 'tv'
      ? 'tv/' + request.tmdbId + '/' + request.season + '/' + request.episode
      : 'movie/' + request.tmdbId;
    return '/api/source/' + mediaPath + '?token=' + encodeURIComponent(playbackToken) + '&provider=vaplayer';
  }

  registerProvider({
    name: 'vidrift',
    title: 'VidRift (experimental)',
    site: 'vidrift',
    hosts: ['https://embed.vidrift.net'],
    probePath: '/embed2/play',
    resolve: function (context, onStreams, onError) {
      var host = context.host;

      function toStreams(rawStreams, subtitles) {
        return (rawStreams || []).filter(function (stream) {
          return stream.type === 'hls' && !stream.direct && (stream.proxyUrl || stream.url);
        }).map(function (stream, position) {
          return {
            label: (stream.name || stream.provider || 'Server') + ' #' + (position + 1),
            info: 'HLS',
            url: absoluteUrl(host, stream.proxyUrl || stream.url),
            subtitles: subtitles.length ? subtitles : false
          };
        });
      }

      function requestOnDemandSource(playbackToken, subtitles) {
        context.network.timeout(30000);
        context.network.silent(context.withProxy(host + vidriftSourcePath(context.request, playbackToken)), function (json) {
          onStreams(json && json.success ? toStreams(json.streams, subtitles) : []);
        }, function () {
          onError('source request failed');
        });
      }

      context.network.timeout(45000);
      context.network.silent(context.withProxy(host + vidriftBootPath(context.request)), function (json) {
        var meta = json && json.meta;
        if (!meta) return onError('bad response');
        var subtitles = ((json.shell && json.shell.subtitles) || []).map(function (subtitle) {
          return { label: subtitle.label || subtitle.lang, url: absoluteUrl(host, subtitle.url) };
        });
        var warmStreams = toStreams(meta.warmStreams, subtitles);
        if (warmStreams.length || !meta.playbackToken) return onStreams(warmStreams);
        requestOnDemandSource(meta.playbackToken, subtitles);
      }, function (xhr) {
        var status = xhr && xhr.status;
        if (status === 451) return onError('blocked by rights holder for this title');
        if (status === 404) return onError('title not found');
        onError(status ? 'request failed (HTTP ' + status + ')' : 'request failed (timeout or network)');
      });
    }
  });

  function vixsrcApiPath(request) {
    if (request.type === 'tv') return '/api/tv/' + request.tmdbId + '/' + request.season + '/' + request.episode;
    return '/api/movie/' + request.tmdbId;
  }

  function matchFirst(text, pattern) {
    var match = text.match(pattern);
    return match ? match[1] : '';
  }

  function parseVixsrcServers(html) {
    try {
      return JSON.parse(matchFirst(html, /window\.streams\s*=\s*(\[[\s\S]*?\])\s*;/) || '[]');
    } catch (parseError) {
      return [];
    }
  }

  function vixsrcPlaylistUrl(serverUrl, html) {
    var token = matchFirst(html, /['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
    var expires = matchFirst(html, /['"]expires['"]\s*:\s*['"]([^'"]+)['"]/);
    var fullHd = /window\.canPlayFHD\s*=\s*true/.test(html);
    return serverUrl + (serverUrl.indexOf('?') === -1 ? '?' : '&') +
      'token=' + encodeURIComponent(token) + '&expires=' + encodeURIComponent(expires) + (fullHd ? '&h=1' : '') + '&lang=en';
  }

  registerProvider({
    name: 'vixsrc',
    title: 'VixSrc',
    site: 'vixsrc',
    hosts: ['https://vixsrc.to'],
    probePath: '/api/movie/550',
    resolve: function (context, onStreams, onError) {
      var host = context.host;
      context.network.timeout(20000);
      context.network.native(context.withProxy(host + vixsrcApiPath(context.request)), function (json) {
        var data;
        try { data = typeof json === 'string' ? JSON.parse(json) : json; }
        catch (error) { return onError('API returned invalid JSON'); }
        if (!data || !data.src) return onStreams([]);
        context.network.native(context.withProxy(absoluteUrl(host, data.src)), function (html) {
          if (!matchFirst(html, /['"]token['"]\s*:\s*['"]([^'"]+)['"]/)) return onError('Missing playback token');
          var streams = parseVixsrcServers(html).filter(function (server) {
            return server.url;
          }).map(function (server) {
            return {
              label: server.name || 'Server',
              info: 'HLS · EN audio · built-in subs',
              url: vixsrcPlaylistUrl(server.url, html),
              subtitles: false
            };
          });
          onStreams(streams);
        }, function () {
          onError('embed page failed');
        }, false, { dataType: 'text' });
      }, function () {
        onError('not found or blocked');
      }, false, { dataType: 'text' });
    }
  });

  providers.sort(function (a, b) { return (a.name === 'vixsrc' ? 0 : 1) - (b.name === 'vixsrc' ? 0 : 1); });

  window.EnOnlineTV = {
    version: VERSION,
    registerProvider: registerProvider
  };

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (event) {
    if (event.type === 'ready') start();
  });
})();
