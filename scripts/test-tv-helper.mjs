import assert from 'node:assert/strict';
import {allowed} from './tv-helper.mjs';
for (const u of ['https://vixsrc.to/api/movie/2123','https://vixsrc.to/api/tv/1396/1/1','https://vixsrc.to/embed/123?token=a'])assert(allowed(new URL(u)),u);
for (const u of ['http://vixsrc.to/api/movie/1','https://evil.test/api/movie/1','https://vixsrc.to.evil.test/api/movie/1','https://user:pass@vixsrc.to/api/movie/1','https://vixsrc.to:8888/api/movie/1','https://vixsrc.to/','https://127.0.0.1/api/movie/1'])assert(!allowed(new URL(u)),u);
console.log('PASS: helper only accepts approved HTTPS API and embed paths');
