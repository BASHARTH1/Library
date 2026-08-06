#!/usr/bin/env node
/** End-to-end smoke test of the streaming RAG chat endpoint. */
const [, , researchId, ...rest] = process.argv;
const question = rest.join(' ') || 'ما هي أهداف هذه الدراسة؟';

const response = await fetch('http://localhost:3000/api/chat/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ question, researchId: researchId || undefined }),
});

if (!response.ok || !response.body) {
  console.error(`HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}

console.log(`Q: ${question}\n`);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let answer = '';

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

    if (event === 'sources') {
      console.log(`RETRIEVED ${parsed.sources.length} chunks:`);
      for (const s of parsed.sources.slice(0, 5)) {
        console.log(`   p.${String(s.pageNumber).padStart(3)}  sim=${s.similarity}  [${s.sectionName ?? '-'}]`);
      }
      console.log('\nANSWER (streaming):');
    } else if (event === 'delta') {
      process.stdout.write(parsed.text);
      answer += parsed.text;
    } else if (event === 'final') {
      console.log('\n\n--- FINAL ---');
      console.log(`confidence : ${parsed.confidence.level} (${parsed.confidence.score})`);
      console.log(`cited pages: ${parsed.citedPages.join(', ') || '(none)'}`);
      console.log(`invalid    : ${parsed.invalidPages.join(', ') || '(none)'}`);
      console.log(`cited srcs : ${parsed.sources.filter((s) => s.wasCited).length}/${parsed.sources.length}`);
      console.log(`model      : ${parsed.usage.model}  tokens=${parsed.usage.totalTokens}  ${parsed.usage.latencyMs}ms`);
      console.log(`conversation: ${parsed.conversationId}`);
    } else if (event === 'error') {
      console.error(`\nERROR: ${parsed.error}`);
    }
  }
}
