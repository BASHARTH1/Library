#!/usr/bin/env node
/**
 * End-to-end check of the deployed site over a real UTF-8 client.
 *
 * curl invoked from Git Bash on Windows mangles Arabic arguments, which makes
 * search look broken when it is not — verify from Node instead.
 */
const URL_BASE = process.env.PROD_URL ?? 'https://gulf-research-repository.vercel.app';
const EMAIL = process.env.API_EMAIL ?? 'dev@gulfuniversity.edu.bh';
const PASSWORD = process.env.API_PASSWORD;

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

console.log(`target: ${URL_BASE}\n--- public ---`);
const stats = await (await fetch(`${URL_BASE}/api/stats`)).json();
line('research / vectors', `${stats.research_count} / ${stats.embedding_count}`);

console.log('\n--- search (UTF-8 queries) ---');
for (const q of ['leadership', 'الذكاء الاصطناعي', 'القيادة', 'كرونباخ ألفا']) {
  const r = await (await fetch(`${URL_BASE}/api/search?q=${encodeURIComponent(q)}&limit=1`)).json();
  line(`"${q}"`, `total=${r.total} semantic=${r.usedSemantic} relaxed=${r.relaxed}`);
}

if (!PASSWORD) {
  console.log('\nSet API_PASSWORD to test the authenticated paths.');
  process.exit(0);
}

console.log('\n--- auth ---');
const login = await fetch(`${URL_BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) { console.error(`  login failed: ${login.status}`); process.exit(1); }
const { accessToken } = await login.json();
line('login', 'ok');

console.log('\n--- search assistant ---');
const find = await fetch(`${URL_BASE}/api/chat/find`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ query: 'الذكاء الاصطناعي', limit: 2 }),
});
const findJson = await find.json();
line('found', findJson.totalFound);
for (const p of findJson.papers ?? []) line('  ·', p.title.slice(0, 48));

console.log('\n--- PDF from private blob ---');
const first = await (await fetch(`${URL_BASE}/api/search?limit=1`)).json();
const rid = first.hits[0].id;
const pdf = await fetch(`${URL_BASE}/api/research/${rid}/file`);
line('status / type', `${pdf.status} ${pdf.headers.get('content-type')}`);
if (pdf.ok) {
  const buf = Buffer.from(await pdf.arrayBuffer());
  line('bytes / signature', `${buf.length} ${buf.subarray(0, 4).toString('latin1')}`);
} else {
  line('body', (await pdf.text()).slice(0, 160));
}
