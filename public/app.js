/* 诗词闯关 —— 题库来自 chinese-poetry-api 的简体库。
 * 低三档（小学/初中/高中）由 poolgen 按课本必背清单驱动，档间接力重叠；
 * 大学、全量两档按「全语料字频 + 篇幅 + 体裁 + 作者流传度」的难度分带抽取。
 */
'use strict';

const LEVELS = [
  { key: 'primary', label: '小学', stages: 8,  blurb: '五七言绝句为主，用字浅近，句式齐整', tag: '入门' },
  { key: 'junior',  label: '初中', stages: 10, blurb: '绝句与律诗，出现常见词牌与典故', tag: '进阶' },
  { key: 'senior',  label: '高中', stages: 12, blurb: '律诗长调并存，生僻字与用典明显增多', tag: '熟手' },
  { key: 'college', label: '大学', stages: 12, blurb: '全集后段难度，元曲、诗经、楚辞与险韵', tag: '硬核' },
  { key: 'full',    label: '全量', stages: 15, blurb: '不设难度门槛，三十四万首里随机抽取', tag: '无限制', full: true },
];

const Q_PER_STAGE = 6;
const LIVES = 3;
const TIME_LIMIT = 30; // 秒
const PASS_LINE = 4;   // 答对 4 题即通关
const STORE_KEY = 'poetryQuest.v1';

const STAGE_NAMES = ['入卷','点笔','寻章','摘句','过韵','联床','问月','听雨','踏雪','临风','酌酒','挥毫','叩舷','披阅','登科'];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ------------------------------------------------------------------ 状态 */

let progress = loadProgress();
const poolCache = new Map();
let session = null; // 当前关卡会话

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* 隐私模式下 localStorage 会抛错，进度丢了不影响玩 */ }
  return { levels: {}, best: 0 };
}
function saveProgress() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch (e) {}
}
function lvlState(key) {
  if (!progress.levels[key]) progress.levels[key] = { unlocked: 1, stars: {}, score: {} };
  return progress.levels[key];
}

/* ------------------------------------------------------------------ 随机 */

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function shuffled(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ------------------------------------------------------------------ 题库 */

async function loadPool(key) {
  if (poolCache.has(key)) return poolCache.get(key);
  const res = await fetch(`data/${key}.json`);
  if (!res.ok) throw new Error(`题库加载失败：${key} (${res.status})`);
  const data = await res.json();
  const pool = { ...data, index: buildIndex(data) };
  poolCache.set(key, pool);
  return pool;
}

// 干扰项必须来自同池，否则选项难度会和题目错位。
function buildIndex(d) {
  const poems = d.poems;
  const byLen = new Map();
  const segs = new Map(); // 2、3 字片段：填空题的干扰项是字组，不是整句
  const titles = [];
  const authors = new Map();
  const chars = new Map();
  const seenClause = new Set();
  const seenSeg = new Set();
  const dynasties = new Set();
  const themes = new Set();
  const seasons = new Set();
  const poemById = new Map(); // 句子里嵌的字要跨诗配对（飞花令）时，按 pid 找回原诗

  for (const p of poems) {
    poemById.set(p.id, p);
    if (p.d) dynasties.add(p.d);
    if (p.th) themes.add(p.th);
    if (p.se) seasons.add(p.se);
    if (p.t && !titles.some((t) => t.text === p.t)) titles.push({ text: p.t, pid: p.id, au: p.a });
    if (p.a) {
      if (!authors.has(p.a)) authors.set(p.a, { name: p.a, dyn: p.d });
    }
    for (const c of p.c) {
      if (!seenClause.has(c)) {
        seenClause.add(c);
        const n = [...c].length;
        if (!byLen.has(n)) byLen.set(n, []);
        byLen.get(n).push({ text: c, pid: p.id });
        for (const ch of new Set(c)) {
          if (!chars.has(ch)) chars.set(ch, []);
          chars.get(ch).push({ text: c, pid: p.id });
        }
      }
      const runes = [...c];
      for (const L of [2, 3]) {
        for (let i = 0; i + L <= runes.length; i++) {
          const seg = runes.slice(i, i + L).join('');
          if (seenSeg.has(L + seg)) continue;
          seenSeg.add(L + seg);
          if (!segs.has(L)) segs.set(L, []);
          segs.get(L).push({ text: seg, pid: p.id });
        }
      }
    }
  }

  // 作者档案：小传里抽出的字、号。作者类题型（字号、配对）从这里取正确项与干扰项。
  const authorMap = new Map();
  const ziHao = new Set();
  for (const a of d.authors || []) {
    if (!a.n) continue;
    authorMap.set(a.n, a);
    if (a.z) ziHao.add(a.z);
    if (a.h) ziHao.add(a.h);
  }

  return {
    byLen, segs, titles,
    authors: [...authors.values()],
    chars,
    poemById,
    dynasties: [...dynasties],
    themes: [...themes],
    seasons: [...seasons],
    authorMap,
    ziHao: [...ziHao],
    clauseCount: seenClause.size,
  };
}

// 每句的标点性质与所属段落。poolgen 随诗发布 p（'d'=句终/'c'=句内）与
// g（base36 段号，律诗一联一段、词一阕一段）。接上下句必须靠它守住同联。
function clauseFlags(p) {
  if (!p.p || !p.g || p.p.length !== p.c.length || p.g.length !== p.c.length) return null;
  return {
    dot: [...p.p].map((ch) => ch === 'd'),
    grp: [...p.g].map((ch) => parseInt(ch, 36)),
  };
}

// 从同长度句子里取干扰项，排除正确项所在的那首诗。
function distractors(pool, rng, want, excludePid, taken, nearLen = 0) {
  const out = [];
  const lens = [];
  for (let d = -nearLen; d <= nearLen; d++) lens.push(want + d);
  for (const round of lens) {
    const bank = pool.index.byLen.get(round);
    if (!bank) continue;
    for (const item of shuffled(rng, bank)) {
      if (out.length >= 12) break;
      if (item.pid === excludePid) continue;
      if (taken.has(item.text)) continue;
      taken.add(item.text);
      out.push(item.text);
    }
  }
  return out;
}

// 填空题的干扰项：与空缺等长的二字/三字片段
function segDistractors(pool, rng, gap, excludePid, taken) {
  const bank = pool.index.segs.get(gap);
  if (!bank) return [];
  const out = [];
  for (const item of shuffled(rng, bank)) {
    if (out.length >= 12) break;
    if (item.pid === excludePid) continue;
    if (taken.has(item.text)) continue;
    taken.add(item.text);
    out.push(item.text);
  }
  return out;
}

/* ------------------------------------------------------------------ 出题 */

const KINDS = ['next', 'prev', 'blank', 'author', 'source', 'feihua', 'theme', 'season', 'dynasty', 'zi', 'workby'];
const KIND_NAME = {
  next: '接下句', prev: '接上句', blank: '补全缺字', author: '辨作者', source: '觅出处', feihua: '飞花令',
  theme: '辨题材', season: '季节意象', dynasty: '查朝代', zi: '作者字号', workby: '作者作品',
};

// 酒令正字：飞花令本就以这些字为令，优先拿它们出题，
// 免得抽到「不」「兮」这种每首诗都有的虚字，题目味道全失。
const FEIHUA_CHARS = ['花', '春', '月', '山', '水', '风', '雨', '雪', '秋', '夜', '云', '梦',
  '愁', '酒', '柳', '桃', '江', '舟', '日', '天', '红', '绿', '寒', '声', '光', '影'];

function makeQuestion(pool, rng, poem, preferred) {
  // 先试这一格位排定的题型，出不了（这首诗缺字号/题材标注等）再随机补其他类型
  const order = [];
  if (preferred) order.push(preferred);
  for (const k of shuffled(rng, KINDS)) if (!order.includes(k)) order.push(k);
  for (const kind of order) {
    const q = builders[kind](pool, rng, poem);
    if (q) return { ...q, kind };
  }
  return null;
}

const builders = {
  next(pool, rng, poem) {
    const f = clauseFlags(poem);
    if (!f) return null;
    // 只考同一联里的出句→对句：本句须以句内标点收尾（!dot），且与下句同段（同 grp）。
    // 跨句号、跨阕的上下句要靠整首背诵，不是「接下一句」该考的。
    const cand = [];
    for (let i = 0; i < poem.c.length - 1; i++) {
      // 同联、句内收尾，且两句字面不同（「行路难，行路难」这类叠句题干=答案，无意义）
      if (!f.dot[i] && f.grp[i] === f.grp[i + 1] && poem.c[i] !== poem.c[i + 1]) cand.push(i);
    }
    if (!cand.length) return null;
    const i = pick(rng, cand);
    const stem = poem.c[i], ans = poem.c[i + 1];
    const opts = optionsFor(pool, rng, ans, poem.id, [...poem.c]);
    if (!opts) return null;
    return {
      prompt: '请选出下一句',
      stem: esc(stem) + '<span class="hint">—— 《' + esc(poem.t) + '》 ' + esc(poem.a) + '</span>',
      answer: ans, options: opts,
      explain: `「${stem}」的下句是「${ans}」。`,
    };
  },

  prev(pool, rng, poem) {
    const f = clauseFlags(poem);
    if (!f) return null;
    const cand = [];
    for (let i = 1; i < poem.c.length; i++) {
      if (!f.dot[i - 1] && f.grp[i] === f.grp[i - 1] && poem.c[i] !== poem.c[i - 1]) cand.push(i);
    }
    if (!cand.length) return null;
    const i = pick(rng, cand);
    const stem = poem.c[i], ans = poem.c[i - 1];
    const opts = optionsFor(pool, rng, ans, poem.id, [...poem.c]);
    if (!opts) return null;
    return {
      prompt: '请选出上一句',
      stem: esc(stem) + '<span class="hint">—— 《' + esc(poem.t) + '》 ' + esc(poem.a) + '</span>',
      answer: ans, options: opts,
      explain: `「${ans}」的下一句是「${stem}」。`,
    };
  },

  blank(pool, rng, poem) {
    const cands = poem.c.filter((c) => [...c].length >= 4);
    if (!cands.length) return null;
    const line = pick(rng, cands);
    const runes = [...line];
    const gap = runes.length >= 7 ? 3 : 2;
    const at = Math.floor(rng() * (runes.length - gap + 1));
    const ans = runes.slice(at, at + gap).join('');
    const shown = runes.slice(0, at).join('') + `<span class="blank">${'　'.repeat(gap)}</span>` + runes.slice(at + gap).join('');

    const taken = new Set([ans, ...poem.c]);
    const others = segDistractors(pool, rng, gap, poem.id, taken);
    const opts = shuffleUnique(rng, [ans, ...others.slice(0, 3)], ans);
    if (!opts) return null;
    return {
      prompt: '补全句中缺字',
      stem: shown + '<span class="hint">—— 《' + esc(poem.t) + '》 ' + esc(poem.a) + '</span>',
      answer: ans, options: opts,
      explain: `原句为「${line}」。`,
    };
  },

  author(pool, rng, poem) {
    const alts = pool.index.authors.filter((a) => a.name !== poem.a);
    if (alts.length < 3 || !poem.a) return null;
    // 同朝代优先，避免「李白 vs 苏轼」这种一眼可辨的送分干扰
    const same = alts.filter((a) => a.dyn === poem.d);
    const rest = alts.filter((a) => a.dyn !== poem.d);
    const chosen = [...shuffled(rng, same).slice(0, 3), ...shuffled(rng, rest).slice(0, 3)].slice(0, 3);
    if (chosen.length < 3) return null;
    const opts = shuffleUnique(rng, [{ text: poem.a }, ...chosen.map((a) => ({ text: a.name }))], poem.a);
    if (!opts) return null;
    return {
      prompt: '这首作品出自谁手',
      stem: esc(poem.c[0]) + '<span class="hint">—— 《' + esc(poem.t) + '》</span>',
      answer: poem.a, options: opts,
      explain: `《${poem.t}》作者为${poem.a}（${poem.d}），体裁${poem.ty || '不详'}。`,
    };
  },

  source(pool, rng, poem) {
    if (poem.c.length < 2) return null;
    const alts = pool.index.titles.filter((t) => t.text !== poem.t);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const opts = shuffleUnique(rng, [{ text: poem.t }, ...chosen.map((t) => ({ text: t.text }))], poem.t);
    if (!opts) return null;
    return {
      prompt: '这几句出自哪首作品',
      stem: esc(poem.c[0]) + '，' + esc(poem.c[1]) + `<span class="hint">—— ${esc(poem.a)} · ${esc(poem.d)}</span>`,
      answer: poem.t, options: opts,
      explain: `出处为《${poem.t}》。`,
    };
  },

  feihua(pool, rng, poem) {
    // 飞花令该考「认得这句诗」，不是「四句里扫出唯一含该字的那句」——后者纯属眼力题。
    // 改法：四个选项全部嵌着同一个令字，其中只有一句真属于题干这首，凭诗篇记忆来挑。
    // 因此只对必背篇目（k>0）出这道题：陌生的诗没人记得，四选一就成了猜。
    if (!(poem.k > 0)) return null;
    const uniq = [...new Set(poem.c.join(''))].filter((ch) => /[㐀-鿿]/.test(ch));
    const has = new Set(uniq);
    const ordered = FEIHUA_CHARS.filter((ch) => has.has(ch)).concat(shuffled(rng, uniq));
    const ok = ordered.find((ch) => {
      const bank = pool.index.chars.get(ch);
      return bank && bank.filter((e) => e.pid !== poem.id).length >= 5;
    });
    if (!ok) return null;
    const mine = poem.c.filter((c) => c.includes(ok));
    const ans = pick(rng, mine);
    const n = [...ans].length;
    const others = pool.index.chars.get(ok).filter((e) => e.pid !== poem.id && e.text !== ans);
    // 干扰句优先等长（更像同一首诗的语气），不够再放宽一句之差
    const near = others.filter((e) => [...e.text].length === n);
    const loose = others.filter((e) => Math.abs([...e.text].length - n) === 1);
    const src = near.length >= 3 ? near : [...near, ...loose];
    const chosen = shuffled(rng, src).slice(0, 3);
    const opts = shuffleUnique(rng, [ans, ...chosen.map((e) => e.text)], ans);
    // 四个选项必须都嵌着「ok」，且恰好一句属于本诗
    if (!opts || opts.length < 4 || !opts.every((o) => o.text.includes(ok))) return null;
    return {
      prompt: `飞花令：四句皆含「${ok}」，选出属于本诗的那句`,
      stem: `<strong>《${esc(poem.t)}》</strong> ${esc(poem.a)}` +
        `<span class="hint">—— 下面四句都嵌着「${esc(ok)}」字，哪一句真的出自这首诗</span>`,
      answer: ans, options: opts,
      explain: `「${ans}」出自${poem.a}《${poem.t}》；其余三句虽同含「${ok}」字，却来自别的作品。`,
    };
  },

  theme(pool, rng, poem) {
    if (!poem.th) return null;
    const alts = pool.index.themes.filter((t) => t !== poem.th);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const opts = shuffleUnique(rng, [poem.th, ...chosen], poem.th);
    if (!opts) return null;
    // 不露标题：题材靠诗意判断，「送元二使安西」这种题名会直接泄底
    return {
      prompt: '这首诗属于哪一类题材',
      stem: poem.c.slice(0, 4).map(esc).join('<br>'),
      answer: poem.th, options: opts,
      explain: `《${poem.t}》归入「${poem.th}」——`+
        `${poem.c.slice(0, 2).join('，')}。`,
    };
  },

  season(pool, rng, poem) {
    if (!poem.se) return null;
    const alts = pool.index.seasons.filter((s) => s !== poem.se);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const opts = shuffleUnique(rng, [poem.se, ...chosen], poem.se);
    if (!opts) return null;
    return {
      prompt: '诗中写的是哪个季节',
      stem: poem.c.slice(0, 4).map(esc).join('<br>') + '<span class="hint">—— 《' + esc(poem.t) + '》</span>',
      answer: poem.se, options: opts,
      explain: `《${poem.t}》的节令意象属「${poem.se}」。`,
    };
  },

  dynasty(pool, rng, poem) {
    if (!poem.d) return null;
    const alts = pool.index.dynasties.filter((x) => x !== poem.d);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const opts = shuffleUnique(rng, [poem.d, ...chosen], poem.d);
    if (!opts) return null;
    return {
      prompt: '这首作品出自哪个朝代',
      stem: esc(poem.c[0]) + `<span class="hint">—— 《${esc(poem.t)}》 ${esc(poem.a)}</span>`,
      answer: poem.d, options: opts,
      explain: `《${poem.t}》作者${poem.a}，属${poem.d}。`,
    };
  },

  zi(pool, rng, poem) {
    const prof = pool.index.authorMap.get(poem.a);
    if (!prof) return null;
    const isZi = !!prof.z;
    const ans = isZi ? prof.z : prof.h;
    if (!ans) return null;
    const alts = pool.index.ziHao.filter((x) => x !== ans);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const opts = shuffleUnique(rng, [ans, ...chosen], ans);
    if (!opts) return null;
    return {
      prompt: isZi ? '这位作者的字是什么' : '这位作者的号是什么',
      stem: esc(poem.c[0]) + `<span class="hint">—— 《${esc(poem.t)}》 ${esc(poem.a)}</span>`,
      answer: ans, options: opts,
      explain: `${poem.a}，字${prof.z || '（失载）'}${prof.h ? '，号' + prof.h : ''}。`,
    };
  },

  workby(pool, rng, poem) {
    if (!poem.a) return null;
    const alts = pool.index.titles.filter((t) => t.text !== poem.t && t.au !== poem.a);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const opts = shuffleUnique(rng, [{ text: poem.t }, ...chosen], poem.t);
    if (!opts) return null;
    return {
      prompt: `下列哪部作品出自${poem.a}之手`,
      stem: `<span class="hint">作者：${esc(poem.a)}（${esc(poem.d)}）</span>`,
      answer: poem.t, options: opts,
      explain: `《${poem.t}》是${poem.a}的作品。`,
    };
  },
};

function optionsFor(pool, rng, ans, pid, forbid) {
  const n = [...ans].length;
  const taken = new Set([ans, ...forbid]);
  const others = distractors(pool, rng, n, pid, taken).filter((t) => [...t].length === n);
  return shuffleUnique(rng, [ans, ...others.slice(0, 3)], ans);
}

// 四选一必须有且仅有一个正确项，且四个选项字面互不相同。
// 正确项只能由 ans 文本比对得出：早先按「打乱后的第一个」置 right，
// 会让 next/prev/blank/飞花令的答案键落到干扰项上，判分与揭示全错。
function shuffleUnique(rng, list, ans) {
  const seen = new Set();
  const uniq = [];
  for (const item of list) {
    const t = typeof item === 'string' ? item : item.text;
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push({ text: t, right: t === ans });
  }
  if (uniq.length < 4) return null;
  const out = shuffled(rng, uniq);
  if (out.filter((o) => o.right).length !== 1) return null;
  return out;
}

// 出题优先用必背篇目（k>0）：小学/初中/高中每一关都该是课本里读过的诗，
// 池内同作者的扩量诗（k 缺省）主要拿来当四选一的干扰项，不主动出成题干。
// 大学、全量两档 k 全为 0，等价于整池随机，行为不变。
function canonFirst(rng, poems) {
  const canon = [], rest = [];
  for (const p of poems) (p.k > 0 ? canon : rest).push(p);
  return shuffled(rng, canon).concat(shuffled(rng, rest));
}

async function buildStage(levelKey, stageIdx) {
  const pool = await loadPool(levelKey);
  const rng = mulberry32(hashStr(`${levelKey}:${stageIdx}:v1`));
  const qs = [];
  const usedPoems = new Set();
  const order = canonFirst(rng, pool.poems);
  // 题型配额：把每种题型排进轮转队列，避免「接下一句」一统天下，
  // 也让题材、字号、朝代这些新类型每一关都有机会露面。
  const plan = shuffled(rng, [...KINDS, ...KINDS, ...KINDS]);
  let slot = 0;

  let guard = 0;
  for (const p of order) {
    if (qs.length >= Q_PER_STAGE || guard++ > 400) break;
    if (usedPoems.has(p.id)) continue;
    const q = makeQuestion(pool, rng, p, plan[slot++ % plan.length]);
    if (!q) continue;
    usedPoems.add(p.id);
    q.poem = p;
    qs.push(q);
  }
  if (qs.length < Q_PER_STAGE) {
    // 兜底：允许同池复用诗作，但换一种题型，保证每关题量稳定
    for (const p of order) {
      if (qs.length >= Q_PER_STAGE) break;
      const q = makeQuestion(pool, rng, p);
      if (q) { q.poem = p; qs.push(q); }
    }
  }
  return { pool, questions: qs };
}

/* ------------------------------------------------------------------ 渲染 */

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${id}`));
  window.scrollTo(0, 0);
}

function renderHome() {
  const wrap = $('#levels');
  wrap.innerHTML = '';
  for (const lv of LEVELS) {
    const st = lvlState(lv.key);
    const totalStars = Object.values(st.stars).reduce((a, b) => a + b, 0);
    const cleared = Object.values(st.stars).filter((s) => s > 0).length;
    const card = document.createElement('button');
    card.className = 'level-card';
    card.disabled = true;
    card.innerHTML = `
      <div class="lc-top"><span class="lc-name">${lv.label}</span><span class="lc-tag ${lv.full ? 'full' : ''}">${lv.tag}</span></div>
      <div class="lc-desc">${lv.blurb}</div>
      <div class="lc-meta">
        <span>已通 <b>${cleared}</b>/${lv.stages} 关</span>
        <span>题量 <b class="pool-n" data-key="${lv.key}">…</b> 首</span>
        <span class="lc-stars">${'★'.repeat(Math.min(totalStars, 5)) || '—'}</span>
      </div>`;
    card.onclick = () => openMap(lv.key);
    wrap.appendChild(card);
  }
  // 题库分片较大（每档 180–340KB），首页只取元信息不下载正文
  LEVELS.forEach(async (lv) => {
    const el = document.querySelector(`.pool-n[data-key="${lv.key}"]`);
    try {
      const res = await fetch(`data/${lv.key}.json`);
      const data = await res.json();
      if (el) el.textContent = data.shipped.toLocaleString();
    } catch (e) {
      if (el) el.textContent = '缺';
    }
  });
  document.querySelectorAll('.level-card').forEach((c) => (c.disabled = false));
}

async function openMap(levelKey) {
  const lv = LEVELS.find((l) => l.key === levelKey);
  show('map');
  const st = lvlState(levelKey);
  $('#map-title').textContent = `${lv.label} · 选关`;
  $('#map-summary').textContent = lv.blurb;
  const grid = $('#stages');
  grid.innerHTML = '';
  for (let i = 1; i <= lv.stages; i++) {
    const locked = i > st.unlocked;
    const stars = st.stars[i] || 0;
    const best = st.score[i] || 0;
    const b = document.createElement('button');
    b.className = 'stage' + (locked ? ' locked' : '');
    b.innerHTML = `<div class="no">第 ${i} 关</div><div class="nm">${STAGE_NAMES[(i - 1) % STAGE_NAMES.length]}</div>
      <div class="st">${stars ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '未闯'}</div>
      <div class="bs">${best ? best + ' 分' : '—'}</div>`;
    if (!locked) b.onclick = () => startStage(levelKey, i);
    grid.appendChild(b);
  }
}

async function startStage(levelKey, stageIdx) {
  const { pool, questions } = await buildStage(levelKey, stageIdx);
  if (!questions.length) { alert('该档题库不足以出题'); return; }
  session = {
    levelKey, stageIdx, pool, questions,
    i: 0, lives: LIVES, score: 0, combo: 0, correct: 0, answered: false, timer: null, left: TIME_LIMIT,
  };
  show('quiz');
  renderQuestion();
}

function renderQuestion() {
  const q = session.questions[session.i];
  $('#q-index').textContent = `第 ${session.i + 1} 题 / ${session.questions.length}`;
  $('#q-kind').textContent = KIND_NAME[q.kind];
  $('#prompt').textContent = q.prompt;
  $('#stem').innerHTML = q.stem;
  $('#hud-score').textContent = session.score;
  renderLives();
  $('#combo').textContent = session.combo >= 2 ? `连对 ${session.combo} 题 · 连击加成 +${Math.min(session.combo * 25, 100)}` : '';

  const opts = $('#options');
  opts.innerHTML = '';
  ['甲', '乙', '丙', '丁'].forEach((g, idx) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<span class="gi">${g}</span><span>${esc(q.options[idx].text)}</span>`;
    b.onclick = () => answer(idx, b);
    opts.appendChild(b);
  });

  $('#reveal-card').classList.add('hidden');
  $('#question-card').classList.remove('hidden');
  startTimer();
}

function startTimer() {
  clearInterval(session.timer);
  session.left = TIME_LIMIT;
  session.answered = false;
  const fill = $('#timer-fill');
  fill.style.width = '100%';
  fill.parentElement.classList.remove('low');
  session.timer = setInterval(() => {
    session.left -= 0.1;
    const pct = Math.max(0, session.left / TIME_LIMIT) * 100;
    fill.style.width = pct + '%';
    if (session.left <= 8) fill.parentElement.classList.add('low');
    if (session.left <= 0) { clearInterval(session.timer); if (!session.answered) answer(-1, null); }
  }, 100);
}

function answer(choiceIdx, btn) {
  if (session.answered) return;
  session.answered = true;
  clearInterval(session.timer);

  const q = session.questions[session.i];
  const right = choiceIdx >= 0 && q.options[choiceIdx].right;
  const buttons = $$('#options .opt');
  buttons.forEach((b, i) => {
    b.disabled = true;
    if (q.options[i].right) b.classList.add('right');
  });
  if (!right && choiceIdx >= 0) buttons[choiceIdx].classList.add('wrong');

  const timeBonus = right ? Math.round(Math.max(0, session.left) * 3) : 0;
  if (right) {
    session.correct++;
    session.combo++;
    const gain = 100 + Math.min(session.combo * 25, 100) + timeBonus;
    session.score += gain;
    $('#hud-score').textContent = session.score;
  } else {
    session.combo = 0;
    session.lives--;
    renderLives();
  }

  const p = q.poem;
  $('#verdict').innerHTML = right
    ? `<span class="yes">✓ 对</span>`
    : `<span class="no">${choiceIdx < 0 ? '✗ 超时' : '✗ 错'}</span> 正确项为「${esc(q.answer)}」`;
  $('#reveal-source').textContent = `${p.a} · ${p.d} · ${p.ty || '其他'}`;
  $('#reveal-poem').innerHTML = `<strong>《${esc(p.t)}》</strong><br>` + revealLines(p, q);
  $('#reveal-explain').textContent = q.explain;
  $('#reveal-card').classList.remove('hidden');
  $('#btn-next').textContent =
    session.lives <= 0 ? '查看结果' :
    session.i + 1 >= session.questions.length ? '查看结果' : '下一题 →';
}

// 全量档最长有 56 句，整首要滚半屏。只展示答案所在句附近的窗口。
function revealLines(p, q) {
  const marks = ['blank', 'next', 'prev', 'feihua'];
  const at = marks.includes(q.kind) ? p.c.findIndex((c) => c.includes(q.answer)) : -1;
  const WIN = 14;
  let from = 0, to = p.c.length;
  if (p.c.length > WIN + 4) {
    to = at >= 0 ? Math.min(p.c.length, Math.max(WIN, at + Math.ceil(WIN / 2))) : WIN;
    from = Math.max(0, to - WIN);
  }
  const out = [];
  if (from > 0) out.push(`<span class="omit">…… 以上 ${from} 句未展示</span>`);
  for (let i = from; i < to; i++) {
    const line = esc(p.c[i]);
    out.push(i === at ? line.replace(esc(q.answer), `<em>${esc(q.answer)}</em>`) : line);
  }
  if (to < p.c.length) out.push(`<span class="omit">…… 以下 ${p.c.length - to} 句未展示</span>`);
  return out.join('<br>');
}

function renderLives() {  $('#lives').innerHTML = Array.from({ length: LIVES }, (_, i) =>
    i < session.lives ? '♥' : '<span class="lost">♥</span>').join('');
}

function nextQuestion() {
  session.i++;
  if (session.lives <= 0 || session.i >= session.questions.length) return finishStage();
  renderQuestion();
}

function finishStage() {
  const { levelKey, stageIdx, correct } = session;
  const cleared = correct >= PASS_LINE;
  const stars = !cleared ? 0 : correct >= 6 ? 3 : correct >= 5 ? 2 : 1;
  const lv = LEVELS.find((l) => l.key === levelKey);
  const st = lvlState(levelKey);

  st.stars[stageIdx] = Math.max(st.stars[stageIdx] || 0, stars);
  st.score[stageIdx] = Math.max(st.score[stageIdx] || 0, session.score);
  if (cleared && stageIdx + 1 <= lv.stages) st.unlocked = Math.max(st.unlocked, stageIdx + 1);
  progress.best = Math.max(progress.best || 0, session.score);
  saveProgress();

  show('result');
  $('#result-seal').textContent = cleared ? (stars === 3 ? '状元' : '及第') : '下第';
  $('#result-seal').classList.toggle('fail', !cleared);
  $('#result-stars').textContent = cleared ? '★★★'.slice(0, stars) + `☆`.repeat(3 - stars) : '☆☆☆';
  $('#result-title').textContent = cleared
    ? `${lv.label} 第 ${stageIdx} 关通过`
    : `${lv.label} 第 ${stageIdx} 关未通过`;
  $('#result-sub').textContent = cleared
    ? (stageIdx < lv.stages ? `第 ${stageIdx + 1} 关已解锁` : '这一档的全部关卡都已踏平')
    : `本关需答对 ${PASS_LINE} 题，再试一次`;

  const accuracy = Math.round((correct / session.questions.length) * 100);
  $('#result-stats').innerHTML = `
    <div><b>${session.score}</b>得分</div>
    <div><b>${correct}/${session.questions.length}</b>答对</div>
    <div><b>${accuracy}%</b>正确率</div>`;

  const hasNext = cleared && stageIdx < lv.stages;
  $('#btn-continue').style.display = hasNext ? '' : 'none';
  $('#btn-continue').onclick = () => startStage(levelKey, stageIdx + 1);
  $('#btn-retry').onclick = () => startStage(levelKey, stageIdx);
}

/* ------------------------------------------------------------------ 联动 API */

async function syncCorpus() {
  const info = $('#corpus-info');
  const dot = document.querySelector('.corpus-bar .dot');
  try {
    const res = await fetch('/api/v1/stats');
    if (!res.ok) throw new Error(String(res.status));
    const s = await res.json();
    info.textContent = `已连接诗词 API：${s.total_poems.toLocaleString()} 首 · ${s.total_authors.toLocaleString()} 位作者 · 简繁双库可切换`;
    dot.classList.add('live');
  } catch (e) {
    info.textContent = '诗词 API 未就绪（不影响闯关；启动 chinese-poetry-api 后可用「随机一诗」与简繁切换）';
    dot.classList.add('off');
  }
}

let dailyLang = 'zh-Hans';
async function loadDaily() {
  const body = $('#daily-body');
  body.textContent = '…';
  try {
    const res = await fetch(`/api/v1/poems/random?lang=${dailyLang}`);
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const p = j.data ?? j;
    body.innerHTML = `<strong>《${esc(p.title)}》</strong> ${esc(p.author?.name)} · ${esc(p.dynasty?.name)}<br>` +
      (p.content || []).map(esc).join('<br>') +
      `<div class="who">体裁：${esc(p.type?.name ?? '—')}（lang=${dailyLang}，切换即读另一张表）</div>`;
  } catch (e) {
    body.textContent = 'API 未启动，暂无法取诗。';
  }
}

/* ------------------------------------------------------------------ 绑定 */

$('#lang-switch').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  dailyLang = b.dataset.lang;
  $$('#lang-switch button').forEach((x) => x.classList.toggle('on', x === b));
  loadDaily();
});

$('#btn-reset').onclick = () => {
  if (!confirm('清空所有难度、关卡星级与分数？')) return;
  progress = { levels: {}, best: 0 };
  saveProgress();
  renderHome();
};

$('#btn-quit').onclick = () => {
  clearInterval(session?.timer);
  const k = session?.levelKey || 'primary';
  openMap(k);
};
$('#btn-next').onclick = nextQuestion;

$$('[data-go]').forEach((b) => (b.onclick = () => {
  if (b.dataset.go === 'home') renderHome(), show('home'), syncCorpus(), loadDaily();
  else openMap(session?.levelKey || 'primary');
}));

renderHome();
show('home');
syncCorpus();
loadDaily();
