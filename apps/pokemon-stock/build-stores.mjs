// 점포 목록 파일(stores.json)을 만드는 스크립트. 웹페이지가 아니라 내 컴퓨터에서 한 번씩 실행한다.
// 실행:  node build-stores.mjs      (점포가 새로 생기거나 없어졌을 때 다시 실행하면 목록이 갱신된다)
//
// 하는 일
// 1. 권역(구)마다 CU, GS25, 이마트24 점포를 공개 재고조회 서버에서 모은다. (세븐일레븐은 build-seven.mjs)
// 2. 재고를 조회할 때 쓸 "조회 지점"을 계산한다. 서버가 한 번에 주는 점포 수에 한계가 있어서,
//    권역의 모든 점포가 빠지지 않도록 지점을 여러 개 고른다.
// 3. 결과를 stores.json 으로 저장한다(점포명, 주소, 좌표만. 전화번호는 저장하지 않는다).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const API = 'https://mcp.aka.page/';
const OUT = new URL('./stores.json', import.meta.url); // 결과를 저장할 파일
const MAX_CALLS = 900; // 서버에 부담을 주지 않도록 정한 호출 상한

// 권역 목록. match = 점포 주소에 모두 들어 있어야 하는 글자, seeds = 점포 찾기를 시작할 역 좌표,
// seven = 세븐일레븐 점포 검색어(세븐일레븐은 좌표가 아니라 검색어로만 점포를 찾는다)
const REGIONS = [
  { id: 'seocho', group: '서울', name: '서초구', area1: '서울특별시', area2: '서초구', match: ['서울', '서초구'], seven: '서초', seeds: [[37.4934, 127.0142], [37.4842, 127.0346]] },
  { id: 'gangnam', group: '서울', name: '강남구', area1: '서울특별시', area2: '강남구', match: ['서울', '강남구'], seven: '강남', seeds: [[37.4979, 127.0276], [37.5089, 127.0631]] },
  { id: 'songpa', group: '서울', name: '송파구', area1: '서울특별시', area2: '송파구', match: ['서울', '송파구'], seven: '송파', seeds: [[37.5133, 127.1001]] },
  { id: 'junggu', group: '서울', name: '중구', area1: '서울특별시', area2: '중구', match: ['서울', '중구'], seven: '서울 중구', seeds: [[37.5547, 126.9707], [37.5636, 126.9869]] },
  { id: 'paldal', group: '수원', name: '팔달구', area1: '경기도', area2: '수원시 팔달구', match: ['수원', '팔달구'], seven: '팔달', seeds: [[37.2660, 127.0000], [37.2619, 127.0309]] },
  { id: 'yeongtong', group: '수원', name: '영통구', area1: '경기도', area2: '수원시 영통구', match: ['수원', '영통구'], seven: '영통', seeds: [[37.2886, 127.0516], [37.2515, 127.0712]] },
  { id: 'bundang', group: '판교·분당', name: '분당구', area1: '경기도', area2: '성남시 분당구', match: ['성남', '분당구'], seven: '분당', seeds: [[37.3948, 127.1112], [37.3670, 127.1081], [37.3849, 127.1233]] },
];

// "좌표 주변 점포"를 주는 편의점의 조회 특성.
//   listRadius = 점포 찾기 1회가 덮는 반경(m), cap = 1회에 주는 최대 점포 수(없으면 0)
//   spacing    = 점포 찾기 지점 사이의 간격(m). 작을수록 꼼꼼하지만 호출이 늘어난다
//   stockRadius/stockCap = 재고조회 1회가 덮는 반경과 점포 수(여유를 두고 실제보다 작게 잡는다)
const NEARBY = {
  cu: { tool: 'cu_find_nearby_stores', limit: 300, listRadius: 1190, cap: 0, spacing: 800, stockRadius: 900, stockCap: Infinity },
  gs25: { tool: 'gs25_find_nearby_stores', limit: 100, listRadius: 990, cap: 50, spacing: 650, stockRadius: 900, stockCap: 45 },
};
const E24_BATCH = 30; // 이마트24 재고조회 1회가 덮는 점포 수. 실제 상한은 40곳이지만 여유를 둔다

let calls = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = text => console.log(`[${new Date().toTimeString().slice(0, 8)}] STORES ${text}`);

// 서버의 조회 도구 하나를 부른다. 실패하면 1번만 다시 시도한다.
async function callTool(name, args, retry = true) {
  if (calls >= MAX_CALLS) throw new Error('호출 상한 도달');
  calls++;
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data: '));
    const msg = JSON.parse(line ? line.slice(6) : text);
    if (msg.error || msg.result.isError) throw new Error('조회 도구 오류');
    await sleep(250); // 서버에 부담을 주지 않게 잠깐 쉰다
    return msg.result.structuredContent || JSON.parse(msg.result.content[0].text);
  } catch (e) {
    if (!retry) throw e;
    await sleep(1500);
    return callTool(name, args, false);
  }
}

// 두 좌표 사이의 거리(m). 지구가 둥글다는 점을 반영한 공식(하버사인)
function dist(a, b) {
  const rad = d => d * Math.PI / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
console.assert(Math.abs(dist([37.4979, 127.0276], [37.5547, 126.9707]) - 8060) < 150, 'dist: 강남역~서울역 약 8km');

// 조회 지점 고르기: "가장 많은 미조회 점포를 덮는 점포"를 지점으로 삼기를 반복한다.
// covers(s) = s 를 지점으로 조회했을 때 함께 나오는 점포들
function pickPoints(stores, covers) {
  const left = new Set(stores);
  const points = [];
  while (left.size) {
    let best = null, bestHit = [];
    for (const s of left) {
      const hit = covers(s).filter(t => left.has(t));
      if (hit.length > bestHit.length) { best = s; bestHit = hit; }
    }
    points.push([best.lat, best.lng]);
    bestHit.forEach(t => left.delete(t));
  }
  return points;
}
{ // 자체 점검: 멀리 떨어진 두 무리는 지점 2개
  const t = [{ lat: 37.5, lng: 127.0 }, { lat: 37.501, lng: 127.0 }, { lat: 37.6, lng: 127.0 }];
  const p = pickPoints(t, s => t.filter(x => dist([s.lat, s.lng], [x.lat, x.lng]) <= 900));
  console.assert(p.length === 2, 'pickPoints: 지점 2개');
}

const regionOf = address => REGIONS.find(r => r.match.every(m => address.includes(m)));
const clean = s => s.replace(/\s+/g, ' ').trim();
const stores = []; // 모든 편의점의 대상 권역 점포가 여기에 모인다
const prevRegions = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')).regions : []; // 지난번에 저장한 권역 정보

// ---------- 이마트24: 구 이름으로 40곳씩 페이지를 넘기며 모은다 ----------
for (const r of REGIONS) {
  let count = 0;
  for (let page = 1; page <= 15; page++) {
    let list;
    try {
      list = (await callTool('emart24_find_nearby_stores', { area1: r.area1, area2: r.area2, page, limit: 40 })).stores;
    } catch (e) { log(`이마트24 ${r.name} ${page}쪽 실패 (${e.message})`); break; }
    for (const s of list) {
      if (stores.some(x => x.chain === 'emart24' && x.code === s.storeCode)) continue;
      stores.push({ chain: 'emart24', region: r.id, code: s.storeCode, name: s.storeName, address: clean(s.address), lat: Number(s.latitude), lng: Number(s.longitude) });
      count++;
    }
    if (list.length < 40) break; // 40곳보다 적게 왔으면 마지막 쪽이다
  }
  log(`이마트24 ${r.name}: ${count}곳`);
}

// ---------- CU, GS25: 좌표 주변 점포만 주므로, 찾은 점포를 발판 삼아 옆으로 넓혀 가며 모은다 ----------
// 이마트24 → CU → GS25 순서로 모으고, 앞에서 모은 점포 위치를 뒤 편의점의 예비 지점으로 쓴다.
for (const [chain, cfg] of Object.entries(NEARBY)) {
  const found = new Map();  // 점포 코드 → 점포
  const centers = [];       // 이미 조회한 지점
  const queue = REGIONS.flatMap(r => r.seeds);
  // 예비 지점: 먼저 모은 다른 편의점의 점포 위치. 점포 사이가 멀어 발판이 끊긴 동네를 메우는 데 쓴다
  // (편의점이 있는 동네에는 다른 편의점도 있기 쉽다).
  const spare = stores.map(s => [s.lat, s.lng]);
  let failed = 0;
  while (queue.length || spare.length) {
    if (!queue.length) {
      // 옆으로 넓혀 갈 곳이 더 없으면, 예비 지점 중 지금까지의 조회 지점에서 먼 곳을 조회한다
      const p = spare.pop();
      if (centers.every(q => dist(q, p) > cfg.spacing)) queue.push(p);
      continue;
    }
    const c = queue.shift();
    centers.push(c);
    let list;
    try {
      list = (await callTool(cfg.tool, { latitude: c[0], longitude: c[1], limit: cfg.limit })).stores;
    } catch (e) { failed++; log(`${chain} 지점 조회 실패 (${e.message})`); continue; }
    // 점포 수가 상한에 걸렸으면 이번 조회가 실제로 덮은 반경은 가장 먼 점포까지다
    const covered = cfg.cap && list.length >= cfg.cap ? Math.max(...list.map(s => s.distanceM)) : cfg.listRadius;
    const need = Math.min(cfg.spacing, covered * 0.8);
    for (const s of list) {
      const p = [Number(s.latitude), Number(s.longitude)];
      const region = regionOf(s.address);
      if (!found.has(s.storeCode)) found.set(s.storeCode, { chain, region: region && region.id, code: s.storeCode, name: s.storeName, address: clean(s.address), lat: p[0], lng: p[1] });
      // 대상 권역 안의 점포이고, 지금까지의 지점들과 충분히 멀면 다음 조회 지점으로 등록한다
      if (region && [...centers, ...queue].every(q => dist(q, p) > need)) queue.push(p);
    }
    if (centers.length % 20 === 0) log(`${chain} 점포 찾는 중: 지점 ${centers.length}곳 조회, 대기 ${queue.length}곳, 대상 권역 점포 ${[...found.values()].filter(s => s.region).length}곳`);
  }
  const mine = [...found.values()].filter(s => s.region);
  stores.push(...mine);
  log(`${chain} 완료: 조회 ${centers.length}회(실패 ${failed}), 대상 권역 점포 ${mine.length}곳`);
}

// 세븐일레븐은 조회 방식이 달라 build-seven.mjs 가 따로 채운다. 여기서는 지난번에 저장한 내용을 그대로 둔다.

// ---------- 이번에 조회가 실패한 곳은 지난번에 저장한 목록을 그대로 쓴다 (실패했다고 목록이 비면 안 된다) ----------
if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, 'utf8')).stores;
  for (const r of REGIONS) for (const chain of ['emart24', 'seveneleven']) {
    const old = prev.filter(s => s.chain === chain && s.region === r.id);
    if (old.length && !stores.some(s => s.chain === chain && s.region === r.id)) {
      stores.push(...old);
      log(`${chain} ${r.name}: 이번 조회 실패 → 지난번 목록 ${old.length}곳을 유지`);
    }
  }
}

// ---------- 권역별 점포 수와 재고 조회 지점 계산 → 저장 ----------
const round = n => Math.round(n * 1e5) / 1e5; // 좌표는 소수 5자리(약 1m)까지만
const valid = stores.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
const byDist = (list, s) => [...list].sort((a, b) => dist([s.lat, s.lng], [a.lat, a.lng]) - dist([s.lat, s.lng], [b.lat, b.lng]));
const regions = REGIONS.map(r => {
  const mine = chain => valid.filter(s => s.chain === chain && s.region === r.id);
  const points = {};
  for (const [chain, cfg] of Object.entries(NEARBY)) {
    const near = s => byDist(mine(chain), s).filter(t => dist([s.lat, s.lng], [t.lat, t.lng]) <= cfg.stockRadius).slice(0, cfg.stockCap);
    points[chain] = pickPoints(mine(chain), near);
    // 자체 점검: 모든 점포가 어떤 조회 지점의 반경 안에 있어야 한다
    console.assert(mine(chain).every(s => points[chain].some(p => dist(p, [s.lat, s.lng]) <= cfg.stockRadius)), `${r.name} ${chain}: 덮이지 않은 점포가 있음`);
  }
  points.emart24 = pickPoints(mine('emart24'), s => byDist(mine('emart24'), s).slice(0, E24_BATCH));
  const count = {};
  for (const chain of Object.keys(points)) { count[chain] = mine(chain).length; points[chain] = points[chain].map(p => p.map(round)); }
  // 세븐일레븐의 조회용 검색어는 build-seven.mjs 가 만든 것을 그대로 옮긴다
  count.seveneleven = mine('seveneleven').length;
  points.seveneleven = ((prevRegions.find(x => x.id === r.id) || {}).points || {}).seveneleven || [];
  return { id: r.id, group: r.group, name: r.name, area1: r.area1, area2: r.area2, count, points };
});

writeFileSync(OUT, JSON.stringify({
  builtAt: new Date().toLocaleString('sv-SE').replace(' ', 'T'),
  source: '공개 재고조회 서버 mcp.aka.page',
  regions,
  stores: valid.map(s => ({ ...s, lat: round(s.lat), lng: round(s.lng) })),
}));

for (const r of regions) log(`${r.group} ${r.name}: ` + Object.keys(r.count).map(c => `${c} ${r.count[c]}곳(지점 ${r.points[c].length})`).join(', '));
log(`저장 완료: 점포 ${valid.length}곳, 서버 호출 ${calls}회`);
