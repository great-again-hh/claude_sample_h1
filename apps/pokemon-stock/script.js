// JavaScript = 페이지의 "동작".
// 이 파일이 하는 일:
//   1) 저장해 둔 점포 목록(stores.json)을 읽어 권역 체크박스를 만든다.
//   2) [재고 조회] 버튼 → 체크한 권역의 점포만 공개 서버에 실시간 조회(진행률 %).
//      네이버 지도를 체크했으면 편의점 대신 내 위치 10km 안의 판매처를 찾아 지도에 띄운다.
//   3) 편의점별 점포 수 요약 → 재고가 있는 점포만 목록으로 → 점포를 누르면 지도.
// 데이터를 화면에 넣을 때는 항상 textContent 를 쓴다(글자로만 들어가서 안전하다).

// ---------- 1. 계산만 하는 함수 (화면을 건드리지 않는다) ----------

// 점포 하나에 재고가 있는가? = 상품 중 하나라도 수량이 1 이상
const hasStock = store => Object.values(store.stock).some(n => n > 0);

// 한 편의점의 점포들을 세어 요약 숫자를 돌려준다.
// unknown = 모든 상품이 null(확인불가)인 점포, soldOut = 나머지(확인된 상품이 전부 0)
function summarize(stores, chainId) {
  const mine = stores.filter(s => s.chain === chainId);
  const inStock = mine.filter(hasStock).length;
  const unknown = mine.filter(s => Object.values(s.stock).every(n => n === null)).length;
  return { total: mine.length, inStock, unknown, soldOut: mine.length - inStock - unknown };
}

// 재고 값 하나를 글자로 바꾼다: 숫자 → "재고 3", 0 → "품절", null → "확인불가"
function stockLabel(n) {
  if (n === null || n === undefined) return '확인불가';
  return n > 0 ? '재고 ' + n : '품절';
}

// 서버 응답은 "data: {...}" 줄에 JSON 이 담겨 오는 형식(SSE)이다. 그 줄을 찾아 꺼낸다.
function parseSse(text) {
  const line = text.split('\n').find(l => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}

// 자체 점검: 숫자, 0, null 이 섞인 예시로 위 함수들이 맞는지 확인한다. 틀리면 콘솔에 오류가 찍힌다.
const sample = [
  { chain: 'a', stock: { x: 0, y: 3 } },
  { chain: 'a', stock: { x: 0, y: null } },
  { chain: 'a', stock: { x: null, y: null } },
  { chain: 'b', stock: { x: null } },
];
const sumA = summarize(sample, 'a');
console.assert(sumA.total === 3 && sumA.inStock === 1 && sumA.unknown === 1 && sumA.soldOut === 1, 'summarize: a');
console.assert(summarize(sample, 'b').unknown === 1 && summarize(sample, 'none').total === 0, 'summarize: b, none');
console.assert(stockLabel(3) === '재고 3' && stockLabel(0) === '품절' && stockLabel(null) === '확인불가', 'stockLabel');
console.assert(parseSse('event: message\ndata: {"a":1}\n').a === 1 && parseSse('{"b":2}').b === 2, 'parseSse');

// ---------- 2. 조회 설정 ----------
// 공개 재고조회 서버(오픈소스 daiso-mcp)에 브라우저가 직접 물어본다. 설치·로그인·키가 필요 없다.
// 보내는 정보는 입력칸에 적은 상품 검색어와 stores.json 에 있는 조회 지점 좌표·구 이름뿐이다.
const API = 'https://mcp.aka.page/';
const PARALLEL = 3; // 동시에 보내는 조회 수. 서버에 부담을 주지 않도록 작게 둔다

// 편의점 목록. note 가 있는 편의점은 재고를 조회하지 않고 그 이유만 보여 준다.
const CHAINS = [
  { id: 'cu', name: 'CU' },
  { id: 'gs25', name: 'GS25' },
  // shortcut: 세븐일레븐은 점포 수만 세고 재고는 조회하지 않는다, 서버의 세븐일레븐 연결이 안정되면 CU 처럼 조회 추가
  { id: 'seveneleven', name: '세븐일레븐', note: '재고 조회 불가 (서버의 세븐일레븐 연결 오류)' },
  { id: 'emart24', name: '이마트24' },
];

// 조회할 상품은 화면의 입력칸에 직접 적는다. 편의점마다 그 검색어로 찾은 "첫 번째 상품"의 재고를 조회하고,
// 어떤 상품이 골라졌는지는 결과의 요약 카드에 보여 준다.
const chainName = id => CHAINS.find(c => c.id === id).name;

// ---------- 3. 화면 상태와 도우미 ----------

let catalog = null;     // stores.json 내용: 권역 목록(regions)과 점포 목록(stores)
let result = null;      // 마지막 편의점 조회 결과: { stores, failed, calls, chains, matched, reason, keyword }
let chainFilter = null; // 요약 카드를 눌러 고른 편의점 id (없으면 전체)
let me = null;          // 내 위치 [위도, 경도]. 이 브라우저 안에서 거리 계산에만 쓰고 어디에도 보내거나 저장하지 않는다

// 두 좌표 사이의 거리(m). 지구가 둥글다는 점을 반영한 공식(하버사인)
function distanceM(a, b) {
  const rad = d => d * Math.PI / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
// 거리를 읽기 좋게: 1km 미만은 "350m", 그 이상은 "1.2km"
const distanceLabel = m => m < 1000 ? Math.round(m / 10) * 10 + 'm' : (m / 1000).toFixed(1) + 'km';
console.assert(Math.abs(distanceM([37.4979, 127.0276], [37.5547, 126.9707]) - 8060) < 150, 'distanceM: 강남역~서울역 약 8km');
console.assert(distanceLabel(348) === '350m' && distanceLabel(1234) === '1.2km', 'distanceLabel');

// 내 위치를 브라우저에 묻는다(브라우저가 허락을 구하는 창을 띄운다). 거절하거나 실패하면 null.
function locate() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve([pos.coords.latitude, pos.coords.longitude]),
      () => resolve(null),
      { timeout: 8000, maximumAge: 60000 }, // 8초 안에 못 찾으면 포기, 1분 안에 찾은 위치는 다시 쓴다
    );
  });
}

const $ = id => document.getElementById(id);

// 태그를 만들고 글자를 넣어 돌려주는 작은 도우미
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const checkedRegions = () => catalog.regions.filter(r => $('r-' + r.id).checked);
const checkedChains = () => CHAINS.filter(c => $('c-' + c.id).checked);

// 조회 목록 만들기: 체크한 권역 × 체크한 편의점의 조회 지점. 목록의 길이가 곧 서버 호출 횟수다.
function buildTasks(regions, chains) {
  const tasks = [];
  for (const region of regions) for (const chain of chains.filter(c => !c.note)) {
    for (const point of region.points[chain.id]) tasks.push({ region, chain: chain.id, point });
  }
  return tasks;
}

// ---------- 4. 편의점·권역 체크박스 ----------

// 편의점 체크박스: 여러 개를 고를 수 있다. 처음에는 모두 체크돼 있다.
function renderChains() {
  const saved = JSON.parse(localStorage.getItem('pokemon-stock-chains') || 'null'); // 지난번에 체크한 편의점
  for (const c of CHAINS) {
    const label = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.id = 'c-' + c.id;
    input.checked = saved ? saved.includes(c.id) : true;
    label.append(input, el('span', c.name), el('small', `점포 ${catalog.regions.reduce((sum, r) => sum + r.count[c.id], 0)}곳`));
    $('chains').append(label);
  }
  $('chains').addEventListener('change', updateEstimate);
}

function renderRegions() {
  const saved = JSON.parse(localStorage.getItem('pokemon-stock-regions') || '[]'); // 지난번에 체크한 권역을 기억해 둔다
  const groups = [...new Set(catalog.regions.map(r => r.group))];
  for (const group of groups) {
    const box = el('fieldset');
    const legend = el('legend', group);
    const all = el('button', '전체', 'all');
    all.type = 'button';
    legend.append(all);
    box.append(legend);

    for (const r of catalog.regions.filter(r => r.group === group)) {
      const label = el('label');
      const input = el('input');
      input.type = 'checkbox';
      input.id = 'r-' + r.id;
      input.checked = saved.includes(r.id);
      const count = el('small');
      count.id = 'n-' + r.id; // 점포 수는 updateEstimate 가 체크한 편의점 기준으로 채운다
      label.append(input, el('span', r.name), count);
      box.append(label);
    }
    // [전체] 버튼: 모두 체크돼 있으면 모두 풀고, 아니면 모두 체크한다
    all.addEventListener('click', () => {
      const inputs = [...box.querySelectorAll('input')];
      const on = !inputs.every(i => i.checked);
      inputs.forEach(i => { i.checked = on; });
      updateEstimate();
    });
    $('regions').append(box);
  }
  $('regions').addEventListener('change', updateEstimate);
  updateEstimate();
}

// 체크가 바뀔 때마다 대상 점포 수와 예상 조회 횟수를 보여 준다
function updateEstimate() {
  const regions = checkedRegions();
  const chains = checkedChains();
  localStorage.setItem('pokemon-stock-regions', JSON.stringify(regions.map(r => r.id)));
  localStorage.setItem('pokemon-stock-chains', JSON.stringify(chains.map(c => c.id)));
  // 권역 옆의 점포 수: 체크한 편의점의 점포만 더한다
  const storesIn = r => chains.reduce((sum, c) => sum + r.count[c.id], 0);
  for (const r of catalog.regions) $('n-' + r.id).textContent = `점포 ${storesIn(r)}곳`;

  if ($('naver-mode').checked) { $('estimate').textContent = '네이버 지도 선택됨 · 내 위치 10km 안의 판매처를 찾습니다(조회 최대 16회). 상품 칸이 비어 있으면 포켓몬카드로 찾고, 포켓몬 카드를 찾을 때는 무인문구점도 함께 찾습니다. 편의점 선택은 잠깁니다.'; return; }
  if (chains.length === 0 || regions.length === 0) { $('estimate').textContent = '네이버 지도, 또는 편의점과 권역을 체크하세요.'; return; }
  const stores = regions.reduce((sum, r) => sum + storesIn(r), 0);
  const calls = buildTasks(regions, chains).length;
  const seconds = Math.ceil(calls * 1.4 / PARALLEL); // 조회 1회에 약 1.4초
  const time = seconds < 60 ? `약 ${seconds}초` : `약 ${Math.ceil(seconds / 60)}분`;
  $('estimate').textContent = `대상 점포 ${stores}곳 · 조회 ${calls}회 · ${time}`;
}

// ---------- 5. 실시간 조회 ----------

// 서버의 조회 도구 하나를 부른다. 실패하면 서버가 알려 준 이유를 담아 오류를 던진다(throw).
async function callTool(name, args) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(10000), // 10초 안에 답이 없으면 기다리지 않고 넘어간다(실패로 센다)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const msg = parseSse(await res.text());
  if (msg.error) throw new Error(msg.error.message || '서버 오류');
  if (msg.result.isError) throw new Error(msg.result.content[0].text.slice(0, 200));
  return msg.result.structuredContent || JSON.parse(msg.result.content[0].text);
}

// 실패 이유를 화면에 보여 줄 짧은 말로 바꾼다
function reasonText(e) {
  const text = String((e && e.message) || e);
  if (e && e.name === 'TimeoutError') return '서버 응답이 10초 넘게 지연됨';
  if (/찾을 수 없|검색된 상품 없음/.test(text)) return '검색된 상품 없음';
  if (/인증/.test(text)) return '서버의 재고 서비스 인증 오류 (서버 운영자가 복구해야 함)';
  if (/RELAY|릴레이/.test(text)) return '서버와 편의점 사이의 연결 오류';
  if (/403|Forbidden/.test(text)) return '편의점 서버가 요청을 거부함';
  return '서버 오류';
}
console.assert(reasonText(new Error('상품 검색 결과에서 PLU 코드를 찾을 수 없습니다.')) === '검색된 상품 없음', 'reasonText');

// 일꾼 PARALLEL 명이 목록에서 하나씩 꺼내 처리한다 (한꺼번에 다 보내면 서버에 부담이 된다)
async function pool(list, work) {
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < list.length) await work(list[next++]);
  }));
}

// 진행 막대와 상태 글자를 바꾼다
function showProgress(done, total, label) {
  const percent = total ? Math.round(done / total * 100) : 100;
  $('bar').value = percent;
  $('status').textContent = `${percent}% · ${label} (${done}/${total})`;
}

// 체크한 편의점·권역의 점포만 조회한다.
//   1단계: 편의점마다 한 곳만 먼저 조회해 "어떤 상품이 골라지는지" 정한다. 못 정하면 그 편의점은 건너뛴다.
//   2단계: 나머지 조회 지점을 차례로 조회한다.
//   3단계: 실패한 조회만 한 번 더 시도한다.
async function queryLive(regions, chains, keyword) {
  // 대상 점포: 저장된 목록에서 체크한 권역·편의점의 점포만 고른다. 재고(stock)는 조회하며 채운다.
  const regionIds = regions.map(r => r.id);
  const chainIds = chains.map(c => c.id);
  const targets = new Map(); // "편의점+점포코드" → 점포
  for (const s of catalog.stores) if (regionIds.includes(s.region) && chainIds.includes(s.chain)) targets.set(s.chain + s.code, { ...s, stock: {} });

  const tasks = buildTasks(regions, chains);
  const total = tasks.length;
  const failed = {}, calls = {};
  for (const id of chainIds) { failed[id] = 0; calls[id] = tasks.filter(t => t.chain === id).length; }
  let done = 0;

  const matched = {}; // 편의점마다 골라진 상품: { code: 바코드, name: 상품명, word: 통한 검색어 }
  const reason = {};  // 편의점 전체를 조회하지 못했을 때의 이유

  // 같은 편의점의 조회가 모두 같은 상품을 보고 있는지 확인한다. 다른 상품이 골라졌으면 그 응답은 버린다.
  const lock = (chain, code, name, word) => {
    if (!code) throw new Error('검색된 상품 없음');
    if (!matched[chain]) matched[chain] = { code, name: name || word, word };
    if (matched[chain].code !== code) throw new Error('다른 상품이 선택됨');
  };

  // 조회 1회: 응답에 나온 점포 중 대상 점포에만 수량을 적는다. 실패하면 오류를 던진다.
  async function ask({ region, chain, point }, word) {
    const at = { keyword: word, latitude: point[0], longitude: point[1] };
    const code = matched[chain] && matched[chain].code; // 이미 골라진 상품이 있으면 바코드로 정확히 지정한다
    if (chain === 'cu') {
      // CU: 검색어로만 상품을 고를 수 있다. 좌표 주변 약 1km 의 점포 수량이 온다.
      const d = await callTool('cu_check_inventory', { ...at, storeLimit: 100 });
      lock(chain, d.nearbyStores.stockItemCode, d.nearbyStores.stockItemName, word);
      for (const s of d.nearbyStores.stores) {
        const t = targets.get('cu' + s.storeCode);
        if (t) t.stock.qty = s.stock;
      }
    } else if (chain === 'gs25') {
      // GS25: 좌표 주변 약 1km, 최대 50곳의 수량이 온다.
      const d = await callTool('gs25_check_inventory', { ...at, ...(code && { itemCode: code }), storeLimit: 100 });
      lock(chain, d.itemCode, d.product && d.product.name, word);
      for (const s of d.inventory.stores) {
        const t = targets.get('gs25' + s.storeCode);
        if (t) t.stock.qty = s.realStockQuantity;
      }
    } else {
      const d = await callTool('emart24_check_inventory', { ...at, ...(code && { pluCd: code }), area1: region.area1, area2: region.area2, storeLimit: 40 });
      lock(chain, d.pluCd, d.inventory.goodsInfo && d.inventory.goodsInfo.goodsNm, word);
      // 이마트24: 재고 기록이 있는 점포만 inventory.stores 에 나온다(0개 포함). 없는 점포는 확인불가로 남는다.
      for (const i of d.inventory.stores) {
        const near = d.nearbyStores.stores.find(s => s.storeCode === i.bizNo || s.storeName === i.storeName);
        const t = near && targets.get('emart24' + near.storeCode);
        if (t) t.stock.qty = i.bizQty;
      }
    }
  }

  // 검색어 후보: 적은 그대로, 그리고 띄어쓰기를 없앤 것.
  // (이마트24는 "포켓몬 카드"로는 상품을 못 찾고 "포켓몬카드"로는 찾는다)
  const words = [...new Set([keyword, keyword.replace(/\s+/g, '')])];
  if (words.length === 1) words.push(keyword); // 후보가 하나뿐이면 같은 검색어로 한 번 더 시도한다

  // 1단계
  const rest = [];
  for (const chain of chains.filter(c => !c.note)) {
    const mine = tasks.filter(t => t.chain === chain.id);
    if (mine.length === 0) continue;
    showProgress(done, total, `${chain.name} 상품 확인 중`);
    let error = null;
    for (const word of words) {
      try { await ask(mine[0], word); error = null; break; } catch (e) { error = e; }
    }
    if (error) {
      // 상품을 정하지 못했으면 이 편의점의 나머지 조회는 해 봐야 소용없으니 건너뛴다
      reason[chain.id] = reasonText(error);
      failed[chain.id] = mine.length;
      done += mine.length;
    } else {
      done++;
      rest.push(...mine.slice(1));
    }
  }

  // 2단계
  const again = [];
  await pool(rest, async task => {
    try { await ask(task, matched[task.chain].word); done++; } catch (e) { again.push(task); }
    showProgress(done, total, `${task.region.name} ${chainName(task.chain)} 조회 중`);
  });

  // 3단계
  await pool(again, async task => {
    try { await ask(task, matched[task.chain].word); } catch (e) { failed[task.chain]++; }
    done++;
    showProgress(done, total, `${task.region.name} ${chainName(task.chain)} 다시 조회 중`);
  });
  showProgress(total, total, '완료');

  // 응답에 한 번도 나오지 않은 점포는 값이 비어 있다 → 확인불가(null)로 채운다
  const stores = [...targets.values()];
  for (const s of stores) if (!('qty' in s.stock)) s.stock.qty = null;

  return { stores, failed, calls, chains, matched, reason, keyword };
}

// 조회 중에는 버튼을 잠그고 진행 막대를 보여 준다
function setBusy(busy) {
  $('load-btn').disabled = busy;
  $('bar').hidden = !busy;
  if (busy) $('bar').value = 0;
}

// 편의점 재고 조회를 실행하고 결과를 그린다
async function runStores(keyword) {
  const regions = checkedRegions();
  const chains = checkedChains();
  if (chains.length === 0 || regions.length === 0) { $('status').textContent = '조회할 편의점과 권역을 하나 이상 체크하세요.'; return; }

  // 조회와 동시에 내 위치를 묻는다. 기다리지 않고, 위치를 알게 되면 그때 목록을 가까운 순으로 다시 그린다.
  locate().then(pos => { me = pos; if (result && !$('load-btn').disabled && !$('result').hidden) renderList(); });
  setBusy(true);
  result = await queryLive(regions, chains, keyword);
  setBusy(false);

  const reasons = Object.values(result.reason);
  const asked = chains.filter(c => !c.note).length;
  $('status').textContent = asked > 0 && reasons.length === asked
    ? (reasons.every(r => r === '검색된 상품 없음') ? '검색된 상품이 없습니다. 검색어를 바꿔 보세요.' : '재고를 조회하지 못했습니다. 요약 카드의 이유를 확인하세요.')
    : '';
  $('fetched-at').textContent = '조회 시각 ' + new Date().toLocaleString('sv-SE').slice(0, 16); // sv-SE 형식 = "2026-10-11 20:24"
  chainFilter = null;
  $('scope').textContent = `검색어: ${keyword} · 편의점: ${chains.map(c => c.name).join(', ')} · 권역: ${regions.map(r => r.name).join(', ')}`;
  $('empty').hidden = true;
  $('places').hidden = true;
  $('result').hidden = false;
  renderSummary();
  renderList();
}

// [재고 조회] 버튼: 네이버 지도가 체크돼 있으면 주변 판매처 찾기, 아니면 편의점 재고 조회
$('load-btn').addEventListener('click', async () => {
  if (!catalog) return;
  const keyword = $('keyword').value.trim(); // trim: 앞뒤 공백 제거
  if (keyword) localStorage.setItem('pokemon-stock-keyword', keyword); // 다음에 열어도 같은 검색어가 들어 있게 기억해 둔다
  // 네이버 지도: 입력칸이 비어 있으면 기본 검색어(포켓몬카드)로 찾는다
  if ($('naver-mode').checked) { await runPlaces(keyword || DEFAULT_PLACE_WORD); return; }
  if (!keyword) { $('status').textContent = '조회할 상품을 입력하세요.'; $('keyword').focus(); return; }
  await runStores(keyword);
});

// ---------- 5-2. 네이버 지도: 내 위치 10km 안의 판매처 찾기 ----------
// 공개 서버의 "네이버 지역 검색" 도구를 쓴다. 이 도구는 좌표가 아니라 "지역 이름 + 검색어"로 찾고 한 번에 5곳까지만 준다.
// 그래서 내 주변의 구·동 이름 여러 개로 나눠 검색한 뒤 합치고, 10km 안의 곳만 남긴다.
// 내 좌표는 어디에도 보내지 않는다. 주변 지역 이름은 저장된 점포 목록의 주소에서 알아낸다.
const RADIUS = 10000; // 반경 10km
const MAX_AREAS = 8;  // 검색에 쓸 지역 이름 수 (서버 호출 횟수 = 지역 이름 수 × 검색어 수)
const DEFAULT_PLACE_WORD = '포켓몬카드'; // 입력칸이 비어 있을 때 쓰는 검색어
const EXTRA_PLACE_WORD = '무인문구점';   // 포켓몬 카드를 찾을 때 함께 찾는 곳(포켓몬 카드를 파는 경우가 많다)

// 검색어 목록을 정한다: 포켓몬 카드를 찾는 경우에만 무인문구점도 함께 찾는다
const placeWords = keyword => keyword.replace(/\s+/g, '').includes('포켓몬') ? [keyword, EXTRA_PLACE_WORD] : [keyword];
console.assert(placeWords('포켓몬 카드').length === 2 && placeWords('레고').length === 1, 'placeWords');
let map = null;       // 지도(Leaflet)

// 점포 주소에서 검색에 쓸 지역 이름을 꺼낸다: "경기도 수원시 영통구 … (이의동)" → { gu: '수원 영통구', dong: '수원 이의동' }
function areaNames(address) {
  const t = address.split(' ');
  const seoul = t[0].startsWith('서울');
  const city = seoul ? '서울' : (t[1] || '').replace(/시$/, '');
  const gu = seoul ? t[1] : t[2];
  const dong = (address.match(/\(([가-힣0-9]+동)/) || [])[1];
  return { gu: gu ? `${city} ${gu}` : null, dong: dong ? `${city} ${dong}` : null };
}
console.assert(areaNames('경기도 수원시 영통구 웰빙타운로49번길 36, (이의동)').gu === '수원 영통구', 'areaNames: 구');
console.assert(areaNames('서울 강남구 테헤란로 101, A동 10호(역삼1동 821-1)').dong === '서울 역삼1동', 'areaNames: 동');

async function runPlaces(keyword) {
  setBusy(true);
  $('status').textContent = '내 위치를 확인하는 중...';
  me = await locate();
  if (!me) {
    setBusy(false);
    $('status').textContent = '내 위치를 알 수 없어 조회하지 못했습니다. 브라우저에서 이 사이트의 위치 사용을 허용한 뒤 다시 눌러 주세요.';
    return;
  }

  // 내 주변(10km 안) 점포들의 주소에서 지역 이름을 가까운 순으로 모은다: 구 이름 먼저, 그다음 동 이름
  const near = catalog.stores
    .map(s => ({ s, d: distanceM(me, [s.lat, s.lng]) }))
    .filter(x => x.d <= RADIUS)
    .sort((a, b) => a.d - b.d);
  const gus = [], dongs = [];
  for (const { s } of near) {
    const n = areaNames(s.address);
    if (n.gu && !gus.includes(n.gu)) gus.push(n.gu);
    if (n.dong && !dongs.includes(n.dong)) dongs.push(n.dong);
  }
  const areas = [...gus.slice(0, 4), ...dongs].slice(0, MAX_AREAS);

  // 검색 목록: 지역 이름 × 검색어
  const words = placeWords(keyword);
  const searches = areas.flatMap(area => words.map(word => ({ area, word })));

  const found = new Map(); // "이름+주소" → 장소 (같은 곳이 여러 번 나오면 하나로)
  let done = 0, failedCalls = 0;
  showProgress(0, searches.length, '주변 판매처 찾는 중');
  await pool(searches, async ({ area, word }) => {
    try {
      const d = await callTool('places_search_nearby', { location: area, keyword: word, category: 'all', limit: 5 });
      for (const p of d.places) {
        const place = { name: p.name, category: p.category, address: p.roadAddress || p.address, lat: Number(p.latitude), lng: Number(p.longitude), via: [] };
        place.distance = distanceM(me, [place.lat, place.lng]);
        if (!(place.distance <= RADIUS)) continue; // 10km 밖이거나 좌표가 없는 곳은 뺀다
        const kept = found.get(place.name + place.address) || place;
        if (!kept.via.includes(word)) kept.via.push(word); // 어떤 검색어로 찾았는지 적어 둔다
        found.set(place.name + place.address, kept);
      }
    } catch (e) { failedCalls++; }
    done++;
    showProgress(done, searches.length, `${area} ${word} 검색 중`);
  });
  setBusy(false);

  const list = [...found.values()].sort((a, b) => a.distance - b.distance);
  $('status').textContent = areas.length === 0 ? '내 위치 10km 안에 저장된 점포가 없어 주변 지역 이름을 알 수 없습니다. 서울 서초·강남·송파·중구, 수원, 분당 근처에서만 쓸 수 있습니다.'
    : failedCalls === searches.length ? '주변 판매처를 조회하지 못했습니다. 잠시 후 다시 눌러 주세요.' : '';
  $('fetched-at').textContent = '조회 시각 ' + new Date().toLocaleString('sv-SE').slice(0, 16);
  $('empty').hidden = true;
  $('result').hidden = true;
  $('places').hidden = false;
  renderPlaces(list, words, areas);
}

// 주변 판매처를 지도와 목록으로 그린다
function renderPlaces(list, words, areas) {
  const keyword = words[0];
  $('places-title').textContent = `내 위치 10km 안의 ${words.map(w => `"${w}"`).join(' · ')} ${list.length}곳`;
  $('places-note').textContent = list.length
    ? '네이버 지역 검색 결과를 가까운 순으로 보여 줍니다. 지역 이름 하나에 5곳까지만 나와서 전부는 아닐 수 있고, 재고는 알 수 없습니다. 지도 바탕은 오픈스트리트맵입니다.'
    : '10km 안에서 검색된 곳이 없습니다. 검색어를 바꿔 보거나 아래 링크로 네이버 지도에서 직접 찾아보세요.';
  // 네이버 지도 전체 결과로 가는 링크: 가장 가까운 지역 이름 + 검색어 (내 좌표는 넣지 않는다)
  $('naver-link').href = 'https://map.naver.com/p/search/' + encodeURIComponent(`${areas[0] || ''} ${keyword}`.trim());

  // 지도: Leaflet(CDN 에서 불러온 지도 라이브러리)이 준비돼 있을 때만 그린다
  const markers = [];
  $('map').hidden = !window.L;
  if (window.L) {
    if (map) map.remove(); // 이전 지도를 지우고 새로 만든다
    map = L.map('map');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    const circle = L.circle(me, { radius: RADIUS, color: '#111111', weight: 2, fillOpacity: 0.04 }).addTo(map);
    L.circleMarker(me, { radius: 8, color: '#111111', fillColor: '#ffd23f', fillOpacity: 1 }).addTo(map).bindTooltip('내 위치');
    for (const p of list) {
      // 말풍선 내용은 글자로만 넣는다(textContent)
      const box = el('div');
      box.append(el('strong', p.name), el('br'), el('span', `${p.via.join(', ')} · ${p.address} · ${distanceLabel(p.distance)}`));
      markers.push(L.marker([p.lat, p.lng]).addTo(map).bindPopup(box));
    }
    map.fitBounds(list.length ? L.latLngBounds([me, ...list.map(p => [p.lat, p.lng])]).pad(0.2) : circle.getBounds());
  }

  // 목록: 누르면 지도에서 그 곳의 말풍선이 열린다
  $('places-list').replaceChildren(...list.map((p, i) => {
    const li = el('li');
    const btn = el('button', '', 'store');
    btn.type = 'button';
    btn.append(el('strong', p.name), el('span', p.address, 'where'), el('span', distanceLabel(p.distance), 'where'));
    const tags = el('span', '', 'stocks');
    for (const word of p.via) tags.append(el('span', word, 'stock in')); // 어떤 검색어로 찾은 곳인지
    tags.append(el('span', p.category || '분류 없음', 'stock'));
    btn.append(tags);
    btn.addEventListener('click', () => {
      if (!markers[i]) return;
      map.setView([p.lat, p.lng], 16);
      markers[i].openPopup();
      $('map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    const link = el('a', '네이버 지도에서 보기');
    link.href = 'https://map.naver.com/p/search/' + encodeURIComponent(p.name);
    link.target = '_blank';
    link.rel = 'noopener';
    li.append(btn, link);
    return li;
  }));
}

// ---------- 5-3. 조회 방식 고르기와 초기화 ----------

// 네이버 지도를 체크하면 편의점·권역 선택은 쓸 수 없게 잠근다(둘 중 하나만 조회한다)
function applyMode() {
  const naver = $('naver-mode').checked;
  localStorage.setItem('pokemon-stock-naver', naver ? '1' : '');
  for (const node of document.querySelectorAll('#chains input, #regions input, #regions button')) node.disabled = naver;
  if (catalog) updateEstimate();
}
$('naver-mode').addEventListener('change', applyMode);

// [초기화] 버튼: 모든 선택을 풀고, 검색어는 기본값으로, 결과 화면은 처음 상태로 되돌린다
$('reset-btn').addEventListener('click', () => {
  for (const input of document.querySelectorAll('#naver-mode, #chains input, #regions input')) input.checked = false;
  $('keyword').value = '포켓몬 카드';
  $('store-search').value = '';
  localStorage.removeItem('pokemon-stock-keyword');
  result = null;
  chainFilter = null;
  $('status').textContent = '';
  $('fetched-at').textContent = '';
  $('result').hidden = true;
  $('places').hidden = true;
  $('empty').hidden = false;
  applyMode();
});

// ---------- 5-4. 편의점 연결 상태 ----------
// 페이지가 열릴 때 편의점마다 흔한 상품(삼다수)을 강남역 기준으로 한 번씩 조회해 보고,
// 지금 재고 조회가 되는지를 박스 4개로 보여 준다. (서버 호출 4회)
const HEALTH_AT = { keyword: '삼다수', latitude: 37.4979, longitude: 127.0276 };
// 편의점별 시험 조회. 성공하면 골라진 상품의 바코드(또는 true)를 돌려준다.
const HEALTH_CHECKS = {
  cu: () => callTool('cu_check_inventory', { ...HEALTH_AT, storeLimit: 1 }).then(d => d.nearbyStores.stockItemCode),
  gs25: () => callTool('gs25_check_inventory', { ...HEALTH_AT, storeLimit: 1 }).then(d => d.itemCode),
  seveneleven: () => callTool('seveneleven_check_inventory', { keyword: '삼다수', storeKeyword: '강남', storeLimit: 1 }).then(() => true),
  emart24: () => callTool('emart24_check_inventory', { ...HEALTH_AT, area1: '서울특별시', area2: '강남구', storeLimit: 1 }).then(d => d.pluCd),
};

function checkHealth() {
  $('health').replaceChildren();
  for (const chain of CHAINS) {
    const box = el('div', '', 'health-box');
    const state = el('span', '확인 중…', 'state');
    const detail = el('small', '시험 조회를 보내는 중');
    box.append(el('strong', chain.name), state, detail);
    $('health').append(box);
    HEALTH_CHECKS[chain.id]()
      .then(code => {
        if (!code) throw new Error('검색된 상품 없음');
        state.textContent = '정상';
        state.className = 'state ok';
        // 세븐일레븐은 서버 연결이 되더라도 이 페이지가 아직 재고 조회를 지원하지 않는다
        detail.textContent = chain.note ? '서버 연결은 정상 (이 페이지는 재고 조회 미지원)' : '재고 조회 가능';
      })
      .catch(e => {
        state.textContent = '오류';
        state.className = 'state bad';
        detail.textContent = reasonText(e);
      });
  }
  $('health-note').textContent = `${new Date().toLocaleString('sv-SE').slice(0, 16)}에 편의점마다 한 번씩 시험 조회한 결과입니다. 새로고침하면 다시 확인합니다.`;
}

// ---------- 6. 결과 화면 ----------

// 편의점별 요약 카드: 체크한 권역의 점포 수와 재고 있는 점포 수
function renderSummary() {
  $('summary').replaceChildren();
  for (const chain of result.chains) { // 체크한 편의점만 카드로 보여 준다
    const sum = summarize(result.stores, chain.id);
    const card = el('button', '', 'card');
    card.type = 'button';
    card.setAttribute('aria-pressed', String(chainFilter === chain.id));
    card.append(el('strong', chain.name));
    card.append(el('span', `대상 점포 ${sum.total}곳`, 'count'));

    if (chain.note) {
      // 재고를 조회하지 않는 편의점: 점포 수와 이유만 보여 준다
      card.append(el('small', chain.note));
    } else {
      // 이 편의점에서 검색어로 골라진 상품. 원하는 상품이 아니면 검색어를 더 구체적으로 적으면 된다.
      const m = result.matched[chain.id];
      const why = result.reason[chain.id]; // 이 편의점 전체를 조회하지 못한 이유(없으면 정상)
      card.append(el('small', m ? `상품: ${m.name}` : why === '검색된 상품 없음' ? '검색된 상품이 없습니다' : `조회 불가: ${why || '조회할 지점 없음'}`, 'product'));
      card.append(el('span', `재고 있음 ${sum.inStock}곳`, sum.inStock > 0 ? 'count in' : 'count'));
      card.append(el('small', `품절 ${sum.soldOut}곳 · 확인불가 ${sum.unknown}곳`));
      if (result.failed[chain.id] && !why) card.append(el('small', `조회 ${result.calls[chain.id]}회 중 ${result.failed[chain.id]}회 실패`));
    }
    // 카드를 누르면 아래 목록을 그 편의점만으로 좁힌다. 다시 누르면 전체로 돌아간다.
    card.addEventListener('click', () => {
      chainFilter = chainFilter === chain.id ? null : chain.id;
      renderSummary();
      renderList();
      // 카드를 새로 그리면 키보드 포커스가 사라지므로, 방금 누른 카드에 다시 둔다
      $('summary').children[result.chains.indexOf(chain)].focus();
    });
    $('summary').append(card);
  }
}

// 요약 아래의 목록: 재고가 있는 점포만 보여 준다
function renderList() {
  // 검색창에 글자가 있으면: 조회된 점포 전체(재고 없는 점포 포함)에서 이름·주소로 찾는다.
  // 비어 있으면: 재고가 있는 점포만 보여 준다.
  const word = norm($('store-search').value);
  const shown = result.stores
    .filter(s => word ? norm(s.name + s.address).includes(word) : hasStock(s))
    .filter(s => !chainFilter || s.chain === chainFilter)
    // 내 위치를 알면 가까운 점포부터, 모르면 수량이 많은 점포부터
    .sort((a, b) => me ? distanceM(me, [a.lat, a.lng]) - distanceM(me, [b.lat, b.lng]) : totalQty(b) - totalQty(a));
  const who = chainFilter ? chainName(chainFilter) + ' ' : '';
  $('panel-title').textContent = word ? `검색된 ${who}점포 ${shown.length}곳` : `재고 있는 ${who}점포 ${shown.length}곳`;
  const order = me ? '내 위치에서 가까운 순입니다.' : '재고가 많은 순입니다. 브라우저에서 위치 사용을 허용하면 가까운 순으로 바뀝니다.';
  const none = word ? '조회한 편의점·권역의 점포 중에 검색어와 맞는 점포가 없습니다.' : '선택한 권역에 재고가 있는 점포가 없습니다. 검색창에서 점포를 찾아볼 수 있습니다.';
  $('panel-note').textContent = shown.length ? (word ? '재고가 없는 점포도 함께 보여 줍니다. ' : '') + order + ' 점포를 누르면 아래에 지도가 펼쳐집니다.' : none;
  // shortcut: 한 번에 300곳까지만 그린다(너무 많으면 화면이 느려진다), 더 필요하면 "더 보기" 버튼 추가
  $('store-list').replaceChildren(...shown.slice(0, 300).map(storeItem));
}

// 검색용으로 글자를 다듬는다: 띄어쓰기를 없애고 영문은 소문자로 ("광교 호반" 과 "광교호반" 을 같게 본다)
const norm = text => text.replace(/\s+/g, '').toLowerCase();
console.assert(norm(' 광교 호반 GS ') === '광교호반gs', 'norm');

const totalQty = store => Object.values(store.stock).reduce((sum, n) => sum + (n || 0), 0);

// 점포 한 줄: 누르는 버튼 + (눌렀을 때만) 지도
function storeItem(store, i) {
  const li = el('li');
  const btn = el('button', '', 'store');
  const mapBox = el('div', '', 'map');
  btn.type = 'button';
  mapBox.id = 'map-' + i;
  mapBox.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', mapBox.id);

  btn.append(el('strong', `${chainName(store.chain)} ${store.name}`));
  btn.append(el('span', store.address, 'where'));
  // 권역 이름, 그리고 내 위치를 알면 거리도 함께
  const region = catalog.regions.find(r => r.id === store.region).name;
  btn.append(el('span', me ? `${region} · ${distanceLabel(distanceM(me, [store.lat, store.lng]))}` : region, 'where'));
  // 재고 칩: "상품명: 재고 3". 상품명은 이 편의점에서 검색어로 골라진 상품이다
  const stocks = el('span', '', 'stocks');
  const n = store.stock.qty;
  const kind = n > 0 ? 'in' : n === 0 ? 'out' : 'unknown';
  const m = result.matched[store.chain]; // 조회하지 못한 편의점은 골라진 상품이 없다
  stocks.append(el('span', `${m ? m.name : '재고'}: ${stockLabel(n)}`, 'stock ' + kind));
  btn.append(stocks);

  btn.addEventListener('click', () => {
    const open = mapBox.hidden; // 지금 숨겨져 있으면 펼친다
    mapBox.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open && !mapBox.firstChild) mapBox.append(...mapNodes(store)); // 지도는 처음 펼칠 때만 만든다
  });

  li.append(btn, mapBox);
  return li;
}

// 오픈스트리트맵 iframe 과 카카오맵 링크를 만든다
function mapNodes(store) {
  const { lat, lng } = store;
  const f = n => n.toFixed(6);
  const frame = document.createElement('iframe');
  frame.title = store.name + ' 지도';
  frame.loading = 'lazy';
  // bbox = 지도에 보일 네모 범위(왼쪽, 아래, 오른쪽, 위), marker = 핀 위치
  frame.src = 'https://www.openstreetmap.org/export/embed.html'
    + `?bbox=${f(lng - 0.003)},${f(lat - 0.002)},${f(lng + 0.003)},${f(lat + 0.002)}`
    + `&layer=mapnik&marker=${lat},${lng}`;

  const link = el('a', '카카오맵에서 열기');
  link.href = `https://map.kakao.com/link/map/${encodeURIComponent(store.name)},${lat},${lng}`;
  link.target = '_blank';
  link.rel = 'noopener';
  return [frame, link];
}

// ---------- 7. 시작 ----------
checkHealth(); // 편의점 연결 상태부터 확인한다

// 점포 검색창: 글자를 적을 때마다 목록을 다시 그린다
$('store-search').addEventListener('input', () => { if (result) renderList(); });

// 입력칸: 지난번 검색어를 되살리고, Enter 를 누르면 [재고 조회] 버튼을 누른 것과 같게 한다
$('keyword').value = localStorage.getItem('pokemon-stock-keyword') || $('keyword').value;
$('keyword').addEventListener('keydown', e => { if (e.key === 'Enter') $('load-btn').click(); });

// 저장된 점포 목록을 읽어 편의점·권역 체크박스를 만든다
fetch('stores.json')
  .then(res => { if (!res.ok) throw new Error(res.status); return res.json(); })
  .then(json => {
    catalog = json;
    $('built-at').textContent = `점포 목록 저장일: ${catalog.builtAt.slice(0, 10)} (점포 ${catalog.stores.length}곳)`;
    renderChains();
    renderRegions();
    $('naver-mode').checked = !!localStorage.getItem('pokemon-stock-naver');
    applyMode();
  })
  // 파일을 더블클릭해 연 화면(file://)에서는 브라우저가 fetch 를 막는다. 서버나 배포 주소로 열어야 한다.
  .catch(() => { $('estimate').textContent = '점포 목록(stores.json)을 불러오지 못했습니다.'; });
