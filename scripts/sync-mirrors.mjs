import { writeFile } from 'node:fs/promises';

const FMHY_VIDEO_MARKDOWN = 'https://raw.githubusercontent.com/fmhy/edit/main/docs/video.md';
const OUTPUT_PATH = new URL('../config/mirrors.json', import.meta.url);
const INCLUDED_SECTIONS = new Set([
  'Stream Aggregators',
  'P-Stream Forks',
  'Dedicated-Server',
  'Multi-Server',
  'Free w/ Ads'
]);
const NON_MIRROR_HOSTS = ['reddit.com', 'github.com', 'fmhy', 'discord', 't.me', 'telegram', 'pages.dev/#', 'rentry'];

function toSiteKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isMirrorUrl(url) {
  return /^https?:\/\//.test(url) && !NON_MIRROR_HOSTS.some(fragment => url.includes(fragment));
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function parseSites(markdown) {
  const sites = {};
  let currentSection = null;
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^##\s+▷\s+(.+?)\s*$/);
    if (heading) {
      currentSection = heading[1].replace(/\[([^\]]+)\]\([^)]*\)/, '$1');
      continue;
    }
    if (/^#\s/.test(line)) currentSection = null;
    if (!currentSection || !INCLUDED_SECTIONS.has(currentSection) || !line.startsWith('* ')) continue;
    const beforeDescription = line.split(' - ')[0];
    const links = [...beforeDescription.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)];
    if (!links.length) continue;
    const [, primaryName] = links[0];
    const hosts = [...new Set(links.map(([, , url]) => url).filter(isMirrorUrl).map(originOf).filter(Boolean))];
    if (!hosts.length) continue;
    const key = toSiteKey(primaryName);
    const existing = sites[key];
    sites[key] = {
      name: primaryName,
      section: currentSection,
      starred: line.includes('🌟'),
      hosts: existing ? [...new Set([...existing.hosts, ...hosts])] : hosts
    };
  }
  return sites;
}

const response = await fetch(FMHY_VIDEO_MARKDOWN);
if (!response.ok) throw new Error(`FMHY fetch failed: ${response.status}`);
const sites = parseSites(await response.text());
const config = { source: FMHY_VIDEO_MARKDOWN, updatedAt: new Date().toISOString(), sites };
await writeFile(OUTPUT_PATH, JSON.stringify(config, null, 2) + '\n');
console.log(`Wrote ${Object.keys(sites).length} sites to ${OUTPUT_PATH.pathname}`);
