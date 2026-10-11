// JavaScript = 페이지의 "동작".
// 이 파일이 하는 일:
//   1) 저장해 둔 점포 목록(stores.json)을 읽어 권역 체크박스를 만든다.
//   2) [재고 조회] 버튼 → 체크한 권역의 점포만 공개 서버에 실시간 조회(진행률 %).
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
let result = null;      // 마지막 조회 결과: { stores, failed }
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

  if (chains.length === 0 || regions.length === 0) { $('estimate').textContent = '조회할 편의점과 권역을 체크하세요.'; return; }
  const stores = regions.reduce((sum, r) => sum + storesIn(r), 0);
  const calls = buildTasks(regions, chains).length;
  const seconds = Math.ceil(calls * 1.4 / PARALLEL); // 조회 1회에 약 1.4초
  const time = seconds < 60 ? `약 ${seconds}초` : `약 ${Math.ceil(seconds / 60)}분`;
  $('estimate').textContent = `대상 점포 ${stores}곳 · 조회 ${calls}회 · ${time}`;
}

// ---------- 5. 실시간 조회 ----------

// 서버의 조회 도구 하나를 부른다. 실패하면 오류를 던진다(throw).
async function callTool(name, args) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(10000), // 10초 안에 답이 없으면 기다리지 않고 넘어간다(실패로 센다)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const msg = parseSse(await res.text());
  if (msg.error || msg.result.isError) throw new Error('조회 도구 오류');
  return msg.result.structuredContent || JSON.parse(msg.result.content[0].text);
}

// 체크한 편의점·권역의 점포만 조회한다: 조회 목록을 만들고 → 차례로 부르며 진행률을 올리고 → 결과를 돌려준다
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

  const step = label => {
    const percent = total ? Math.round(done / total * 100) : 100;
    $('bar').value = percent;
    $('status').textContent = `${percent}% · ${label} (${done}/${total})`;
  };

  // 편의점마다 검색어로 골라진 상품을 기억한다: { code: 바코드, name: 상품명 }. 검색 결과가 없으면 null.
  const matched = {};
  // 같은 편의점의 조회가 모두 같은 상품을 보고 있는지 확인한다. 다른 상품이 골라졌으면 그 응답은 버린다.
  const lock = (chain, code, name) => {
    if (!code) { if (!(chain in matched)) matched[chain] = null; throw new Error('검색된 상품 없음'); }
    if (!matched[chain]) matched[chain] = { code, name: name || keyword };
    if (matched[chain].code !== code) throw new Error('다른 상품이 선택됨');
  };

  // 조회 1회: 응답에 나온 점포 중 대상 점포에만 수량을 적는다
  async function runTask({ region, chain, point }) {
    const at = { keyword, latitude: point[0], longitude: point[1] };
    const code = matched[chain] && matched[chain].code; // 이미 골라진 상품이 있으면 바코드로 정확히 지정한다
    try {
      if (chain === 'cu') {
        // CU: 검색어로만 상품을 고를 수 있다. 좌표 주변 약 1km 의 점포 수량이 온다.
        const d = await callTool('cu_check_inventory', { ...at, storeLimit: 100 });
        lock(chain, d.nearbyStores.stockItemCode, d.nearbyStores.stockItemName);
        for (const s of d.nearbyStores.stores) {
          const t = targets.get('cu' + s.storeCode);
          if (t) t.stock.qty = s.stock;
        }
      } else if (chain === 'gs25') {
        // GS25: 좌표 주변 약 1km, 최대 50곳의 수량이 온다.
        const d = await callTool('gs25_check_inventory', { ...at, ...(code && { itemCode: code }), storeLimit: 100 });
        lock(chain, d.itemCode, d.product && d.product.name);
        for (const s of d.inventory.stores) {
          const t = targets.get('gs25' + s.storeCode);
          if (t) t.stock.qty = s.realStockQuantity;
        }
      } else {
        const d = await callTool('emart24_check_inventory', { ...at, ...(code && { pluCd: code }), area1: region.area1, area2: region.area2, storeLimit: 40 });
        lock(chain, d.pluCd, d.inventory.goodsInfo && d.inventory.goodsInfo.goodsNm);
        // 이마트24: 재고 기록이 있는 점포만 inventory.stores 에 나온다(0개 포함). 없는 점포는 확인불가로 남는다.
        for (const i of d.inventory.stores) {
          const near = d.nearbyStores.stores.find(s => s.storeCode === i.bizNo || s.storeName === i.storeName);
          const t = near && targets.get('emart24' + near.storeCode);
          if (t) t.stock.qty = i.bizQty;
        }
      }
    } catch (e) {
      failed[chain]++;
    }
    done++;
    step(`${region.name} ${chainName(chain)} 조회 중`);
  }

  // 일꾼 PARALLEL 명이 목록에서 하나씩 꺼내 처리한다 (한꺼번에 다 보내면 서버에 부담이 된다)
  step('조회 시작');
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < tasks.length) await runTask(tasks[next++]);
  }));

  step('완료');

  // 응답에 한 번도 나오지 않은 점포는 값이 비어 있다 → 확인불가(null)로 채운다
  const stores = [...targets.values()];
  for (const s of stores) if (!('qty' in s.stock)) s.stock.qty = null;

  return { stores, failed, calls, chains, matched, keyword };
}

// [재고 조회] 버튼
$('load-btn').addEventListener('click', async () => {
  if (!catalog) return;
  const regions = checkedRegions();
  const chains = checkedChains();
  const keyword = $('keyword').value.trim(); // trim: 앞뒤 공백 제거
  if (!keyword) { $('status').textContent = '조회할 상품을 입력하세요.'; $('keyword').focus(); return; }
  if (chains.length === 0 || regions.length === 0) { $('status').textContent = '조회할 편의점과 권역을 하나 이상 체크하세요.'; return; }
  localStorage.setItem('pokemon-stock-keyword', keyword); // 다음에 열어도 같은 검색어가 들어 있게 기억해 둔다

  const btn = $('load-btn');
  // 조회와 동시에 내 위치를 묻는다. 기다리지 않고, 위치를 알게 되면 그때 목록을 가까운 순으로 다시 그린다.
  locate().then(pos => { me = pos; if (result && !btn.disabled) renderList(); });
  btn.disabled = true; // 조회 중에 또 누르지 못하게 막는다
  $('bar').hidden = false;
  $('bar').value = 0;
  result = await queryLive(regions, chains, keyword);
  btn.disabled = false;
  $('bar').hidden = true;

  const total = Object.values(result.calls).reduce((a, b) => a + b, 0);
  const failed = Object.values(result.failed).reduce((a, b) => a + b, 0);
  const found = Object.values(result.matched);
  const noProduct = found.length > 0 && found.every(m => m === null); // 모든 편의점에서 검색 결과가 없었다
  $('status').textContent = noProduct ? '검색된 상품이 없습니다. 검색어를 바꿔 보세요.'
    : total > 0 && failed === total ? '재고를 조회하지 못했습니다. 잠시 후 다시 눌러 주세요.' : '';
  $('fetched-at').textContent = '조회 시각 ' + new Date().toLocaleString('sv-SE').slice(0, 16); // sv-SE 형식 = "2026-10-11 20:24"
  chainFilter = null;
  $('scope').textContent = `검색어: ${keyword} · 편의점: ${chains.map(c => c.name).join(', ')} · 권역: ${regions.map(r => r.name).join(', ')}`;
  $('empty').hidden = true;
  $('result').hidden = false;
  renderSummary();
  renderList();
});

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
      card.append(el('small', m ? `상품: ${m.name}` : m === null ? '검색된 상품이 없습니다' : '상품을 확인하지 못했습니다', 'product'));
      card.append(el('span', `재고 있음 ${sum.inStock}곳`, sum.inStock > 0 ? 'count in' : 'count'));
      card.append(el('small', `품절 ${sum.soldOut}곳 · 확인불가 ${sum.unknown}곳`));
      if (result.failed[chain.id] && m !== null) card.append(el('small', `조회 ${result.calls[chain.id]}회 중 ${result.failed[chain.id]}회 실패`));
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
  })
  // 파일을 더블클릭해 연 화면(file://)에서는 브라우저가 fetch 를 막는다. 서버나 배포 주소로 열어야 한다.
  .catch(() => { $('estimate').textContent = '점포 목록(stores.json)을 불러오지 못했습니다.'; });
