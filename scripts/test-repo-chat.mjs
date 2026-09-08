#!/usr/bin/env node
/** Smoke test for the repository-wide assistant (no researchId => all papers). */
const question = process.argv.slice(2).join(' ') || 'What is AI?';
const API = process.env.API_URL ?? 'http://localhost:3100';

// AI endpoints now require an account. Log in with the credentials in the
// environment rather than embedding any password in the script.
const email = process.env.API_EMAIL;
const password = process.env.API_PASSWORD;
let token = process.env.API_TOKEN ?? null;

if (!token && email && password) {
  const auth = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!auth.ok) {
    console.error(`login failed: HTTP ${auth.status} ${await auth.text()}`);
    process.exit(1);
  }
  token = (await auth.json()).accessToken;
}

if (!token) {
  console.error('Set API_EMAIL and API_PASSWORD (or API_TOKEN) — AI endpoints require authentication.');
  process.exit(1);
}

const response = await fetch(`${API}/api/chat/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ question }),
});

if (!response.ok || !response.body) {
  console.error(`HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}

console.log(`Q: ${question}\n`);
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';

  for (const frame of frames) {
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    const parsed = JSON.parse(data);

    if (event === 'delta') process.stdout.write(parsed.text);
    else if (event === 'final') {
      console.log('\n\n--- SOURCE PAPERS ---');
      const byPaper = new Map();
      for (const s of parsed.sources) {
        const entry = byPaper.get(s.researchId) ?? {
          title: s.researchTitle, authors: s.authors, year: s.publicationYear, pages: [], cited: false,
        };
        entry.pages.push(s.pageNumber);
        entry.cited = entry.cited || s.wasCited;
        byPaper.set(s.researchId, entry);
      }
      for (const [id, p] of byPaper) {
        console.log(`${p.cited ? '★ USED' : '  ref '} ${p.title.slice(0, 55)}`);
        console.log(`         ${(p.authors ?? []).join(', ') || '—'} · ${p.year ?? '—'} · pages ${[...new Set(p.pages)].sort((a, b) => a - b).join(', ')}`);
        console.log(`         /research/${id}`);
      }
      console.log(`\nconfidence: ${parsed.confidence.level} (${parsed.confidence.score})`);
      console.log(`invalid refs: ${parsed.invalidPages.join(', ') || 'none'}`);
      console.log(`model: ${parsed.usage.model}  tokens=${parsed.usage.totalTokens}  ${parsed.usage.latencyMs}ms`);
    } else if (event === 'error') console.error(`\nERROR: ${parsed.error}`);
  }
}
