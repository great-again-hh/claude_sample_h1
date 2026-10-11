// JS = 페이지의 "동작". HTML 을 찾아서(선택) → 바꾸고(조작) → 사용자의 행동에 반응(이벤트)한다.

// 1) 데이터: 글 하나 = 객체 { }, 글 여러 개 = 배열 [ ]
const posts = [
  { title: 'HTML 은 뼈대', body: '제목, 문단, 버튼 같은 "무엇이 있는지"를 정한다.', date: '2026-10-08' },
  { title: 'CSS 는 꾸밈', body: '색, 크기, 배치 같은 "어떻게 보이는지"를 정한다.', date: '2026-10-09' },
  { title: 'JS 는 동작', body: '클릭, 입력 같은 "무슨 일이 일어나는지"를 정한다.', date: '2026-10-10' },
];

// 2) 선택: HTML 에서 id 로 요소 찾기
const postList = document.getElementById('post-list');
const form = document.getElementById('post-form');
const themeBtn = document.getElementById('theme-btn');

// 3) 조작: 배열을 화면에 그리는 함수
function render() {
  postList.innerHTML = ''; // 일단 비우고 다시 그린다

  // 최신 글이 위로 오도록 뒤에서부터 반복
  for (const post of posts.toReversed()) {
    const article = document.createElement('article'); // <article> 태그 만들기
    article.className = 'post';                        // CSS 의 .post 스타일 적용

    const h3 = document.createElement('h3');
    const date = document.createElement('div');
    const p = document.createElement('p');
    date.className = 'date';

    // textContent: 글자를 "글자 그대로" 넣는다. 사용자가 <script> 를 입력해도 실행되지 않아 안전하다.
    h3.textContent = post.title;
    date.textContent = post.date;
    p.textContent = post.body;

    article.append(h3, date, p);
    postList.append(article); // 화면에 붙이기
  }
}

// 4) 이벤트: "~하면 ~해라"
themeBtn.addEventListener('click', () => {
  // toggle: alt 클래스가 없으면 붙이고, 있으면 뗀다. 색은 style.css 의 body.alt 가 바꾼다.
  document.body.classList.toggle('alt');
});

form.addEventListener('submit', (event) => {
  event.preventDefault(); // 폼의 기본 동작(페이지 새로고침)을 막는다

  const title = document.getElementById('title').value.trim(); // trim: 앞뒤 공백 제거
  const body = document.getElementById('body').value.trim();
  if (!title || !body) return; // 공백만 입력한 경우 무시

  posts.push({ title, body, date: new Date().toISOString().slice(0, 10) }); // 배열에 추가
  render();     // 다시 그리기
  form.reset(); // 입력칸 비우기
});

// shortcut: 글이 메모리(배열)에만 있어 새로고침하면 사라진다. 유지하려면 localStorage 에 저장.

render(); // 처음 한 번 그리기
