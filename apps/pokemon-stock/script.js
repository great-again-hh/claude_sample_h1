// JavaScript = 페이지의 "동작".
// 이 파일이 하는 일: [재고 조회] 버튼 → data.json 읽기 → 요약 카드 → 점포 목록 → 지도.
// 데이터를 화면에 넣을 때는 항상 textContent 를 쓴다(글자로만 들어가서 안전하다).

// ---------- 1. 계산만 하는 함수 (화면을 건드리지 않는다) ----------

// 한 편의점의 점포들을 세어 요약 숫자를 돌려준다.
// "재고 있는 점포" = 상품 중 하나라도 수량이 1 이상인 점포. null(확인불가)은 재고로 세지 않는다.
function summarize(stores, chainId) {
  const mine = stores.filter(s => s.chain === chainId);
  const inStock = mine.filter(s => Object.values(s.stock).some(n => n > 0));
  return { total: mine.length, inStock: inStock.length };
}

// 재고 값 하나를 글자로 바꾼다: 숫자 → "재고 3", 0 → "품절", null → "확인불가"
function stockLabel(n) {
  if (n === null || n === undefined) return '확인불가';
  return n > 0 ? '재고 ' + n : '품절';
}

// 자체 점검: 숫자, 0, null 이 섞인 예시로 위 함수가 맞는지 확인한다. 틀리면 콘솔에 오류가 찍힌다.
const sample = [
  { chain: 'a', stock: { x: 0, y: 3 } },
  { chain: 'a', stock: { x: 0, y: null } },
  { chain: 'b', stock: { x: null } },
];
console.assert(summarize(sample, 'a').total === 2 && summarize(sample, 'a').inStock === 1, 'summarize: a');
console.assert(summarize(sample, 'b').inStock === 0 && summarize(sample, 'none').total === 0, 'summarize: b, none');
console.assert(stockLabel(3) === '재고 3' && stockLabel(0) === '품절' && stockLabel(null) === '확인불가', 'stockLabel');

// ---------- 2. 화면 ----------

let data = null;        // data.json 내용
let openChain = null;   // 지금 펼쳐진 편의점 id
let region = '전체';    // 지금 고른 지역

const $ = id => document.getElementById(id);

// 태그를 만들고 글자를 넣어 돌려주는 작은 도우미
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// [재고 조회] 버튼: data.json 을 읽어 온다
$('load-btn').addEventListener('click', async () => {
  $('status').textContent = '불러오는 중...';
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch (e) {
    // 파일을 더블클릭해 연 화면(file://)에서는 브라우저가 fetch 를 막는다. 서버나 배포 주소로 열어야 한다.
    $('status').textContent = '재고 데이터를 불러오지 못했습니다';
    return;
  }
  $('status').textContent = '';
  $('fetched-at').textContent = '조회 기준 시각: ' + data.fetchedAt.slice(0, 16).replace('T', ' ');
  $('source').textContent = '출처: ' + data.source + ' 조회 결과';
  $('result').hidden = false;
  renderSummary();
});

// 편의점별 요약 카드 4개
function renderSummary() {
  $('summary').replaceChildren();
  for (const chain of data.chains) {
    const sum = summarize(data.stores, chain.id);
    const card = el('button', '', 'card');
    card.type = 'button';
    card.setAttribute('aria-expanded', String(openChain === chain.id));
    card.setAttribute('aria-controls', 'panel');
    card.append(el('strong', chain.name));
    // 조회에 성공한 편의점만 숫자를 보여 준다. 나머지는 이유(note)만.
    if (chain.status === 'ok') card.append(el('span', `재고 있는 점포 ${sum.inStock} / 전체 ${sum.total}`));
    if (chain.note) card.append(el('small', chain.note));
    card.addEventListener('click', () => {
      openChain = openChain === chain.id ? null : chain.id; // 같은 카드를 다시 누르면 접는다
      renderSummary();
      renderPanel();
      // 카드를 새로 그리면 키보드 포커스가 사라지므로, 방금 누른 카드에 다시 둔다
      $('summary').children[data.chains.indexOf(chain)].focus();
    });
    $('summary').append(card);
  }
}

// 요약 카드 아래의 점포 목록
function renderPanel() {
  const chain = data.chains.find(c => c.id === openChain);
  $('panel').hidden = !chain;
  if (!chain) return;

  const stores = data.stores.filter(s => s.chain === chain.id);
  $('panel-title').textContent = chain.name + ' 점포 목록';
  $('region-filter').replaceChildren();
  $('store-list').replaceChildren();

  // 점포가 없는 편의점: 목록 대신 안내 문구
  if (stores.length === 0) {
    $('panel-note').textContent = `${chain.name}: 보여 줄 점포가 없습니다. 사유:${chain.note || '조회 결과 없음'}`;
    return;
  }
  $('panel-note').textContent = '점포를 누르면 아래에 지도가 펼쳐집니다.';

  // 지역 버튼: 전체 / 서울 / 수원 / 판교
  for (const name of ['전체', ...new Set(data.areas.map(a => a.region))]) {
    const btn = el('button', name);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(region === name));
    btn.addEventListener('click', () => {
      region = name;
      renderPanel();
      $('region-filter').querySelector('[aria-pressed="true"]').focus(); // 새로 그린 버튼에 포커스를 다시 둔다
    });
    $('region-filter').append(btn);
  }

  const shown = stores.filter(s => region === '전체' || areaOf(s).region === region);
  if (shown.length === 0) $('store-list').append(el('li', '이 지역은 조회된 점포가 없습니다. 조회에 실패했을 수 있으니 위 요약 카드의 설명을 확인하세요.'));
  shown.forEach((store, i) => $('store-list').append(storeItem(store, i)));
}

// 점포가 속한 기준 지점(강남역 등)을 찾는다
function areaOf(store) {
  return data.areas.find(a => a.id === store.areaId);
}

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

  btn.append(el('strong', store.name));
  btn.append(el('span', store.address, 'where'));
  btn.append(el('span', `${areaOf(store).name}에서 ${store.distanceM}m`, 'where'));
  // 상품별 재고: "상품명: 재고 3 / 품절 / 확인불가"
  for (const product of data.products.filter(p => p.chain === store.chain)) {
    const n = store.stock[product.id];
    const kind = n > 0 ? 'in' : n === 0 ? 'out' : 'unknown';
    btn.append(el('span', `${product.name}: ${stockLabel(n)}`, 'stock ' + kind));
  }

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
