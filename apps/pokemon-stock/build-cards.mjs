// 팩별 힛카드 목록 파일(cards.json)을 만드는 스크립트. 웹페이지가 아니라 내 컴퓨터에서 한 번씩 실행한다.
// 실행:  node build-cards.mjs      (새 팩이 나오면 PACKS 에 한 줄 추가하고 다시 실행)
//
// 데이터 출처 (둘 다 누구나 쓸 수 있는 공개 자료)
// - TCGdex (api.tcgdex.net): 팩에 들어 있는 카드 번호·이름·등급. 최신 팩은 일본어판 자료만 있다.
// - PokeAPI (pokeapi.co): 포켓몬의 한국어 이름. 일본어 카드 이름을 한국어로 바꾸는 데 쓴다.
// 카드 그림: TCGdex 에 일본어판 그림이 있으면 그것을, 없으면 같은 그림의 영어판 카드를 찾아 그 그림 주소를 적어 둔다.
// (그림 파일은 TCGdex 서버에 있다. 영어판은 팩 구성과 카드 번호가 달라서, 그린 사람·포켓몬·등급이 모두 같은 카드를 찾는다)
import { writeFileSync } from 'node:fs';

// 팩 목록: TCGdex 의 일본어판 팩 번호와 한국어판 이름 (최신 팩이 위).
// official 을 적으면 TCGdex 의 정규 수록 수 대신 그 값을 쓴다.
const PACKS = [
  { id: 'M6', name: '스톰에메랄다' },
  { id: 'M5', name: '어비스아이' },
  { id: 'M4', name: '닌자스피너' },
  { id: 'M3', name: '니힐제로' },
  { id: 'M2a', name: 'MEGA 드림 ex' },
  { id: 'M2', name: '인페르노X' },
  { id: 'M1L', name: '메가브레이브' },
  { id: 'M1S', name: '메가심포니아' },
  { id: 'SV11B', name: '블랙볼트', official: 86 }, // TCGdex 에 정규 수록 수가 174로 잘못 적혀 있어 직접 적는다
  { id: 'SV11W', name: '화이트플레어' },
  { id: 'SV10', name: '로켓단의 영광' },
  { id: 'SV9a', name: '열풍의 아레나' },
  { id: 'SV9', name: '배틀파트너즈' },
  { id: 'SV8a', name: '테라스탈 페스타 ex' },
  { id: 'SV8', name: '초전브레이커' },
];

// 일본어판 팩 → 같은 카드가 들어 있는 영어판 팩(TCGdex 번호). 앞에 적은 팩부터 찾는다.
// 영어판은 일본어판 두 팩을 하나로 묶어 내기도 해서(예: 메가브레이브+메가심포니아 → Mega Evolution) 여러 팩이 같은 곳을 가리킨다.
// 스톰에메랄다는 아직 영어판이 없다.
const EN_SETS = {
  M5: ['me05', 'me04'], M4: ['me04', 'me05'], M3: ['me03'], M2a: ['me02.5'], M2: ['me02'], M1L: ['me01'], M1S: ['me01'],
  SV11B: ['sv10.5b'], SV11W: ['sv10.5w'], SV10: ['sv10'], SV9a: ['sv10', 'sv09'], SV9: ['sv09'], SV8a: ['sv08.5'], SV8: ['sv08'],
};

// 등급: TCGdex 의 영어 표기 → [약자, 한국어 이름, 힛카드인가]
// 힛카드 = 팩에서 가장 드문 등급(SAR 이상)으로 정했다.
const RARITY = {
  'Special illustration rare': ['SAR', '스페셜 아트 레어', true],
  'Hyper rare': ['UR', '울트라 레어', true],
  'Mega Hyper Rare': ['MUR', '메가 울트라 레어', true],
  'Black White Rare': ['BWR', '블랙 화이트 레어', true],
  'Shiny Ultra Rare': ['SSR', '샤이니 슈퍼 레어', true],
  'Ultra Rare': ['SR', '슈퍼 레어', false],
  'Secret Rare': ['SR', '슈퍼 레어', false],
  'Illustration rare': ['AR', '아트 레어', false],
  'Shiny rare': ['S', '샤이니', false],
  'ACE SPEC Rare': ['ACE', '에이스 스펙', false],
  'Double rare': ['RR', '더블 레어', false],
  'Rare': ['R', '레어', false],
  'Uncommon': ['U', '언커먼', false],
  'Common': ['C', '커먼', false],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = text => console.log(`[${new Date().toTimeString().slice(0, 8)}] CARDS ${text}`);
let calls = 0;

// 주소 하나를 읽어 JSON 으로 돌려준다. 실패하면 1번만 다시 시도한다.
async function getJson(url, retry = true) {
  calls++;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await sleep(80); // 서버에 부담을 주지 않게 잠깐 쉰다
    return await res.json();
  } catch (e) {
    if (!retry) throw e;
    await sleep(1500);
    return getJson(url, false);
  }
}

// 포켓몬 번호 → { ko: 한국어 이름, ja: 일본어 이름 }. 같은 포켓몬은 한 번만 물어본다.
const speciesCache = new Map();
async function species(dexId) {
  if (!speciesCache.has(dexId)) {
    try {
      const d = await getJson(`https://pokeapi.co/api/v2/pokemon-species/${dexId}`);
      const pick = lang => (d.names.find(n => n.language.name === lang) || {}).name;
      speciesCache.set(dexId, { ko: pick('ko'), ja: pick('ja-Hrkt') || pick('ja') });
    } catch (e) { speciesCache.set(dexId, {}); }
  }
  return speciesCache.get(dexId);
}

// 일본어 카드 이름을 한국어로 바꾼다.
// "(로켓단의) + (메가) + 포켓몬 이름 + (ex)" 처럼 단순한 모양일 때만 바꾸고, 그 밖에는 틀릴 수 있으니 일본어 이름을 그대로 둔다.
function koreanName(jpName, sp) {
  if (!sp || !sp.ko || !sp.ja) return null;
  const m = jpName.match(/^(ロケット団の)?(メガ)?(.+?)(ex)?$/);
  if (!m || m[3] !== sp.ja) return null;
  return (m[1] ? '로켓단의 ' : '') + (m[2] ? '메가' : '') + sp.ko + (m[4] ? ' ex' : '');
}
console.assert(koreanName('ロケット団のミュウツーex', { ko: '뮤츠', ja: 'ミュウツー' }) === '로켓단의 뮤츠 ex', 'koreanName: 로켓단');
console.assert(koreanName('メガスターミーex', { ko: '아쿠스타', ja: 'スターミー' }) === '메가아쿠스타 ex', 'koreanName: 메가 ex');
console.assert(koreanName('ニャースex', { ko: '나옹', ja: 'ニャース' }) === '나옹 ex', 'koreanName: ex');
console.assert(koreanName('リーリエのピッピex', { ko: '삐삐', ja: 'ピッピ' }) === null, 'koreanName: 복잡한 이름은 바꾸지 않는다');

// 영어판 팩의 시크릿 카드 정보(그린 사람·포켓몬·등급·그림 주소). 같은 팩은 한 번만 읽는다.
const enCache = new Map();
async function enCards(setId) {
  if (!enCache.has(setId)) {
    const list = [];
    try {
      const set = await getJson(`https://api.tcgdex.net/v2/en/sets/${setId}`);
      for (const brief of set.cards.filter(c => Number(c.localId) > set.cardCount.official && c.image)) {
        try {
          const c = await getJson(`https://api.tcgdex.net/v2/en/cards/${brief.id}`);
          list.push({ image: brief.image, rarity: c.rarity, illustrator: c.illustrator, category: c.category, dexId: c.dexId || [] });
        } catch (e) { /* 한 장 실패는 건너뛴다 */ }
      }
      log(`영어판 ${setId}: 시크릿 카드 ${list.length}장 읽음`);
    } catch (e) { log(`영어판 ${setId} 읽기 실패: ${e.message}`); }
    enCache.set(setId, list);
  }
  return enCache.get(setId);
}

// 같은 그림의 카드인가: 그린 사람이 같고, 같은 포켓몬(트레이너 카드는 같은 종류)이고, 등급이 같아야 한다.
// 그린 사람 정보가 없으면 짐작하지 않는다(틀린 그림을 보여 주느니 그림이 없는 편이 낫다).
const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// 등급 표기를 묶는다: TCGdex 는 같은 등급을 판마다 다르게 적기도 한다(금색 카드 = Hyper rare / Mega Hyper Rare 등)
const rarityGroup = r => ({ 'mega hyper rare': 'hyper rare', 'secret rare': 'ultra rare' })[String(r).toLowerCase()] || String(r).toLowerCase();
const sameArt = (jp, en) => norm(jp.illustrator) && norm(jp.illustrator) === norm(en.illustrator)
  && jp.category === en.category
  && [...(jp.dexId || [])].sort().join() === [...en.dexId].sort().join()
  && (!jp.rarity || jp.rarity === 'None' || rarityGroup(jp.rarity) === rarityGroup(en.rarity));
console.assert(sameArt({ illustrator: 'Mitsuhiro Arita', category: 'Pokemon', dexId: [25], rarity: 'Special illustration rare' },
  { illustrator: 'mitsuhiro arita', category: 'Pokemon', dexId: [25], rarity: 'Special illustration rare' }), 'sameArt: 같은 그림');
console.assert(!sameArt({ illustrator: '', category: 'Trainer', dexId: [], rarity: 'Special illustration rare' },
  { illustrator: '', category: 'Trainer', dexId: [], rarity: 'Special illustration rare' }), 'sameArt: 그린 사람을 모르면 짝짓지 않는다');

const unknownRarity = new Set();
const packs = [];
for (const pack of PACKS) {
  let set;
  try { set = await getJson(`https://api.tcgdex.net/v2/ja/sets/${pack.id}`); }
  catch (e) { log(`${pack.name}(${pack.id}) 팩 정보 실패: ${e.message}`); continue; }
  const official = pack.official || set.cardCount.official;
  // 시크릿 카드 = 카드 번호가 정규 수록 수보다 큰 카드 (예: 111/080). 높은 등급은 모두 여기에 있다.
  const secrets = set.cards.filter(c => Number(c.localId) > official);
  const cards = [];
  for (const brief of secrets) {
    let c;
    try { c = await getJson(`https://api.tcgdex.net/v2/ja/cards/${brief.id}`); }
    catch (e) { log(`${pack.name} ${brief.localId}번 실패: ${e.message}`); continue; }
    let [code, rarityName, hit] = RARITY[c.rarity] || ['?', '등급 자료 없음', false];
    if (!RARITY[c.rarity]) unknownRarity.add(String(c.rarity));
    // 스칼렛·바이올렛 시리즈(SV)의 금색 카드는 UR 이다. TCGdex 는 MEGA 시리즈와 같은 이름으로 적어 두었다.
    if (code === 'MUR' && pack.id.startsWith('SV')) [code, rarityName] = ['UR', '울트라 레어'];
    const sp = c.category === 'Pokemon' && c.dexId && c.dexId.length === 1 ? await species(c.dexId[0]) : null;
    cards.push({
      no: `${c.localId}/${String(official).padStart(3, '0')}`,
      name: koreanName(c.name, sp) || c.name, // 한국어로 바꾸지 못하면 일본어 이름 그대로
      jpName: c.name,
      species: sp && sp.ko ? sp.ko : null,     // 어떤 포켓몬인지(한국어). 트레이너 카드는 없다
      rarity: code,
      rarityName,
      hit,
      image: brief.image || null,             // 그림 주소(없으면 null). 뒤에 /low.webp 또는 /high.webp 를 붙여 쓴다
      imageLang: brief.image ? 'ja' : null,   // 그림이 어느 나라 판인지
      // 아래 셋은 영어판 그림을 찾는 데만 쓰고 저장하지 않는다
      _art: { illustrator: c.illustrator, category: c.category, dexId: c.dexId || [], rarity: c.rarity },
    });
  }
  // 시크릿 카드의 등급이 전부 똑같이 적혀 있으면 아직 자료가 정리되지 않은 것이다 → 등급을 모르는 것으로 둔다
  if (cards.length > 5 && new Set(cards.map(c => c.rarity)).size === 1) {
    for (const c of cards) { c.rarity = '?'; c.rarityName = '등급 자료 없음'; c.hit = false; }
  }
  // 일본어판 그림이 없는 카드는 영어판에서 같은 그림을 찾는다
  const used = new Set(); // 이미 짝지은 영어판 카드(한 장을 두 번 쓰지 않는다)
  for (const card of cards.filter(c => !c.image)) {
    for (const setId of EN_SETS[pack.id] || []) {
      const match = (await enCards(setId)).find(en => !used.has(en.image) && sameArt(card._art, en));
      if (match) { used.add(match.image); card.image = match.image; card.imageLang = 'en'; break; }
    }
  }
  for (const card of cards) delete card._art;
  packs.push({ id: pack.id, name: pack.name, jpName: set.name, releaseDate: set.releaseDate, official, total: set.cardCount.total, cards });
  const hits = cards.filter(c => c.hit);
  log(`${pack.name}: 시크릿 ${cards.length}장(그림 ${cards.filter(c => c.image).length}장, 영어판 ${cards.filter(c => c.imageLang === 'en').length}장), 힛카드 ${hits.length}장(그림 ${hits.filter(c => c.image).length}장)`);
}

// 점검: 힛카드를 가려내지 못한 팩을 알려 준다(공개 자료에 등급이 없는 팩)
for (const p of packs) if (!p.cards.some(c => c.hit)) log(`${p.name}: 등급 자료가 없어 힛카드를 가려내지 못함 (시크릿 ${p.cards.length}장)`);

writeFileSync(new URL('./cards.json', import.meta.url), JSON.stringify({
  builtAt: new Date().toLocaleString('sv-SE').replace(' ', 'T'),
  source: 'TCGdex(일본어판 카드 자료, 일본어판·영어판 카드 그림) · PokeAPI(한국어 포켓몬 이름)',
  packs,
}));
if (unknownRarity.size) log(`등급 표에 없는 표기: ${[...unknownRarity].join(' / ')}`);
log(`저장 완료: 팩 ${packs.length}개, 서버 호출 ${calls}회`);
