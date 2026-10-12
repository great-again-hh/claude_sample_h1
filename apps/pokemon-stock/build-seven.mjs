// 세븐일레븐 점포 목록과 "재고 조회용 검색어"를 stores.json 에 채워 넣는 스크립트.
// 실행:  node build-seven.mjs      (CU·GS25·이마트24 는 build-stores.mjs 가 맡는다)
//        node build-seven.mjs yeongtong bundang   ← 일부 권역만 다시 만들 때
//
// 세븐일레븐이 다른 편의점과 다른 점
// - 좌표가 아니라 "검색어"로만 점포를 찾는다(점포 이름이나 주소에 그 글자가 들어 있는 점포가 나온다).
// - 재고조회는 검색어로 찾은 점포를 앞에서부터 정해진 수만큼만 보여 주고, 다음 쪽으로 넘기는 기능이 없다.
// 그래서 권역의 점포를 길 이름(예: "매탄로", "테헤란로") 같은 검색어 여러 개로 나눠,
// 검색어 하나에 점포가 BATCH 곳 이하로 나오도록 골라 둔다. 화면은 이 검색어마다 한 번씩 재고를 조회한다.
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://mcp.aka.page/';
const OUT = new URL('./stores.json', import.meta.url);
const BATCH = 40; // 재고조회 1회가 다루는 최대 점포 수 (많을수록 응답이 느려져 10초를 넘긴다)

// 권역별: word = 점포 목록을 찾는 검색어, match = 주소에 모두 들어 있어야 하는 글자
const SEVEN = {
  seocho: { word: '서초', match: ['서울', '서초구'] },
  gangnam: { word: '강남', match: ['서울', '강남구'] },
  songpa: { word: '송파', match: ['서울', '송파구'] },
  junggu: { word: '중구', match: ['서울', '중구'] },
  paldal: { word: '팔달', match: ['수원', '팔달구'] },
  yeongtong: { word: '영통', match: ['수원', '영통구'] },
  bundang: { word: '분당', match: ['성남', '분당구'] },
};

let calls = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = text => console.log(`[${new Date().toTimeString().slice(0, 8)}] SEVEN ${text}`);

// 서버의 조회 도구 하나를 부른다. 세븐일레븐 연결은 자주 끊겨서, 실패하면 쉬었다가 다시 시도한다.
// waits = 시도하기 전에 쉬는 시간(ms) 목록. 목록의 길이가 시도 횟수다.
async function callTool(name, args, waits = [0, 2000, 5000, 10000]) {
  let last;
  for (const wait of waits) {
    await sleep(wait);
    calls++;
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      const line = text.split('\n').find(l => l.startsWith('data: '));
      const msg = JSON.parse(line ? line.slice(6) : text);
      if (msg.error || msg.result.isError) throw new Error('조회 도구 오류');
      await sleep(400); // 서버에 부담을 주지 않게 잠깐 쉰다
      return msg.result.structuredContent || JSON.parse(msg.result.content[0].text);
    } catch (e) { last = e; }
  }
  throw last;
}

// 주소에서 길 이름을 꺼낸다: "… 영통구 매탄로126번길 22 …" → "매탄로", "… 중구 명동8길 3" → "명동"
function roadOf(address, district) {
  const parts = address.split(' ');
  const start = parts.findIndex(p => p === district || p.endsWith(district)) + 1; // 구 이름 다음부터 찾는다
  const road = parts.slice(start).find(p => /^[가-힣]{2,}\d*(번길|길|로|대로)?/.test(p) && /(로|길)/.test(p));
  return road ? road.match(/^[가-힣]+/)[0] : null;
}
console.assert(roadOf('경기 수원시 영통구 매탄로126번길 22 상가동', '영통구') === '매탄로', 'roadOf: 번길');
console.assert(roadOf('서울특별시 중구 명동8길 3', '중구') === '명동', 'roadOf: 숫자 길');
console.assert(roadOf('서울 강남구 테헤란로 101', '강남구') === '테헤란로', 'roadOf: 로');

const round = n => Math.round(n * 1e5) / 1e5;
const data = JSON.parse(readFileSync(OUT, 'utf8'));
let total = 0;

// 권역 id 를 적어 실행하면 그 권역만 다시 만든다. 예: node build-seven.mjs yeongtong bundang
const only = process.argv.slice(2);

for (const region of data.regions) {
  if (only.length && !only.includes(region.id)) { total += region.count.seveneleven; continue; }
  const cfg = SEVEN[region.id];
  const district = cfg.match[1];

  // 1) 점포 목록: 검색어로 찾은 뒤 주소로 이 권역의 점포만 남긴다
  let list;
  try { list = (await callTool('seveneleven_search_stores', { keyword: cfg.word, limit: 2000 })).stores; }
  catch (e) { log(`${region.name}: 점포 목록 실패 → 지난번 내용을 그대로 둔다`); continue; }
  const mine = new Map();
  for (const s of list) {
    const address = (s.address || '').replace(/\s+/g, ' ').trim();
    if (!cfg.match.every(m => address.includes(m)) || s.closeYn === 'Y') continue;
    if (!Number.isFinite(Number(s.latitude)) || !Number.isFinite(Number(s.longitude))) continue;
    mine.set(s.storeCode, { chain: 'seveneleven', region: region.id, code: s.storeCode, name: s.storeName, address, lat: round(Number(s.latitude)), lng: round(Number(s.longitude)) });
  }

  // 2) 재고 조회용 검색어 고르기: 아직 덮지 못한 점포를 가장 많이 덮을 길 이름부터 서버에 확인해 본다
  const left = new Set(mine.keys());
  let tokens = [];
  const bad = new Set();
  let streak = 0; // 연달아 실패한 횟수. 3번이면 서버의 세븐일레븐 연결이 끊긴 것으로 보고 그만둔다
  const tryToken = async token => {
    let found;
    try { found = (await callTool('seveneleven_search_stores', { keyword: token, limit: 2000 }, [0, 1500])).stores; streak = 0; }
    catch (e) { bad.add(token); streak++; return; }
    const hit = found.map(s => s.storeCode).filter(code => left.has(code));
    // 점포가 너무 많이 나오는 검색어는 재고조회에서 뒤쪽 점포가 잘리므로 쓰지 않는다
    if (found.length > BATCH || hit.length === 0) { bad.add(token); return; }
    tokens.push(token);
    hit.forEach(code => left.delete(code));
  };
  while (left.size && streak < 3) {
    const tally = new Map(); // 길 이름 → 아직 덮지 못한 점포 수(예상)
    for (const code of left) {
      const road = roadOf(mine.get(code).address, district);
      if (road && !bad.has(road)) tally.set(road, (tally.get(road) || 0) + 1);
    }
    if (tally.size === 0) break;
    await tryToken([...tally.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
  // 길 이름으로 덮지 못한 점포는 점포 이름 그대로를 검색어로 쓴다
  for (const code of [...left]) if (left.has(code) && streak < 3) await tryToken(mine.get(code).name);

  // 연결이 끊겨 검색어를 고르지 못했으면, 권역 검색어 하나만 쓴다.
  // 이 경우 재고조회는 그 검색어로 나오는 앞쪽 점포들만 확인되고 나머지는 "확인불가"로 남는다.
  const partial = streak >= 3;
  if (partial) { tokens = [cfg.word]; left.clear(); }

  // 3) stores.json 에 반영: 이 권역의 세븐일레븐 내용을 새것으로 바꾼다. 끝내 덮지 못한 점포는 목록에서 뺀다
  const kept = [...mine.values()].filter(s => !left.has(s.code));
  data.stores = data.stores.filter(s => !(s.chain === 'seveneleven' && s.region === region.id)).concat(kept);
  region.count.seveneleven = kept.length;
  region.points.seveneleven = tokens;
  total += kept.length;
  log(`${region.name}: 점포 ${kept.length}곳, ` + (partial ? '서버 연결이 끊겨 검색어를 고르지 못함 → 권역 검색어 1개만 사용(일부 점포만 재고 확인)' : `재고 조회용 검색어 ${tokens.length}개${left.size ? `, 덮지 못해 뺀 점포 ${left.size}곳` : ''}`));
}

data.builtAt = new Date().toLocaleString('sv-SE').replace(' ', 'T');
writeFileSync(OUT, JSON.stringify(data));
log(`저장 완료: 세븐일레븐 ${total}곳, 서버 호출 ${calls}회`);
