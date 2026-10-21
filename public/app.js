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
// 每关 4 首由 (档, 周目, 关) 钉死，另外 2 首在本档现抽。钉死的意义是让「这一关就是这几首」
// 能被反复练习、成绩可比较；随机位负责周目之间继续扫池子，免得全档只考得到必背头部。
const PIN_PER_STAGE = 4;
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
  if (!progress.levels[key]) progress.levels[key] = { cycle: 1, unlocked: 1, stars: {}, score: {} };
  const st = progress.levels[key];
  if (!st.cycle) st.cycle = 1; // 旧存档没有周目字段，一律当一周目读
  return st;
}

// 一周目的成绩仍用老键名（"1"…"8"）记档，二周目起加周目前缀，历史分数不会被覆盖。
const sKey = (cycle, stage) => (cycle <= 1 ? String(stage) : `${cycle}-${stage}`);
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const cycleLabel = (c) => (c <= 10 ? CN_NUM[c - 1] : String(c));

// 关卡解锁进度按周目各记一份；一周目继续用 unlocked，保持存档兼容。
function gateOf(st, cycle) {
  if (cycle <= 1) return st.unlocked || 1;
  const k = `gate${cycle}`;
  return st[k] || 1;
}
function openGate(st, cycle, upto) {
  if (cycle <= 1) { st.unlocked = Math.max(st.unlocked || 1, upto); return; }
  const k = `gate${cycle}`;
  st[k] = Math.max(st[k] || 1, upto);
}
// 某一档某一周目已通几关
function stagesCleared(st, lv, cycle) {
  let n = 0;
  for (let i = 1; i <= lv.stages; i++) if ((st.stars[sKey(cycle, i)] || 0) > 0) n++;
  return n;
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
const freshNonce = () => Math.floor(Math.random() * 4294967296).toString(36) + Date.now().toString(36);
function shuffled(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ------------------------------------------------------------------ 题库 */

async function loadPool(key) {
  if (poolCache.has(key)) return poolCache.get(key);
  // no-cache：每次带 ETag 回源校验，未变则 304。nginx 给 /data/ 发了 max-age=86400，
  // 不加这一句，本次 19:29 部署后浏览器仍从缓存里读出上一版池（初中 420 首，
  // 含《使至塞上》的「又一体」副本），重生成的题库要等一天才落到读者手上。
  const res = await fetch(`data/${key}.json`, { cache: 'no-cache' });
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
  // 逐项解析要的三类「这一项指的是什么」：作者在本档收了几首、题材/季节/朝代拿哪首做例子、
  // 以及某个字号是谁的字或号（小传抽出来的，按人反查）。
  const authorCount = new Map();
  const themeEg = new Map();
  const seasonEg = new Map();
  const dynEg = new Map();
  const dynCount = new Map();
  // 同一位作者名下同名但确属两首诗（王安石《梅花》有「墙角数枝梅」和「白玉堂前一树梅」），
  // 出处只写「王安石《梅花》第 1 句」时两行一模一样，得补首句才分得开。
  const sameTitle = new Map();

  for (const p of poems) {
    poemById.set(p.id, p);
    const tk = `${p.a}|${p.t}`;
    sameTitle.set(tk, (sameTitle.get(tk) || 0) + 1);
    if (p.d) {
      dynasties.add(p.d);
      dynCount.set(p.d, (dynCount.get(p.d) || 0) + 1);
      if (!dynEg.has(p.d)) dynEg.set(p.d, p);
    }
    if (p.th) { themes.add(p.th); if (!themeEg.has(p.th)) themeEg.set(p.th, p); }
    if (p.se) { seasons.add(p.se); if (!seasonEg.has(p.se)) seasonEg.set(p.se, p); }
    if (p.t && !titles.some((t) => t.text === p.t)) titles.push({ text: p.t, pid: p.id, au: p.a });
    if (p.a) {
      if (!authors.has(p.a)) authors.set(p.a, { name: p.a, dyn: p.d });
      authorCount.set(p.a, (authorCount.get(p.a) || 0) + 1);
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
  // ziOwner 是反查表：解析里要说清「这个号其实是谁的」，光给个号用户无从分辨。
  const authorMap = new Map();
  const ziHao = new Set();
  const ziOwner = new Map();
  for (const a of d.authors || []) {
    if (!a.n) continue;
    authorMap.set(a.n, a);
    if (a.z) { ziHao.add(a.z); if (!ziOwner.has(a.z)) ziOwner.set(a.z, { name: a.n, kind: '字' }); }
    if (a.h) { ziHao.add(a.h); if (!ziOwner.has(a.h)) ziOwner.set(a.h, { name: a.n, kind: '号' }); }
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
    authorCount,
    themeEg,
    seasonEg,
    dynEg,
    dynCount,
    sameTitle,
    ziOwner,
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
// 带着 pid 返回：解析要说出每个错误选项真正的出处，只回文本就查不到原诗了。
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
      out.push({ text: item.text, pid: item.pid });
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
    out.push({ text: item.text, pid: item.pid });
  }
  return out;
}

// 一句/一段在题库里的出处。「见于」而不是「出自」：同一字面可能出现在多首诗里，
// byLen 只留了第一个发现它的 pid，措辞不能越过这个精度。
function clauseSrc(pool, pid, text) {
  const p = pool.index.poemById.get(pid);
  if (!p) return '';
  const i = p.c.indexOf(text);
  const twin = (pool.index.sameTitle.get(`${p.a}|${p.t}`) || 0) > 1 && p.c[0] !== text ? `「${p.c[0]}」` : '';
  return `${p.a || '佚名'}《${p.t || '无题'}》${twin}` + (i >= 0 ? `第 ${i + 1} 句` : '');
}

/* ------------------------------------------------------------------ 出题 */

const KINDS = ['next', 'prev', 'blank', 'author', 'source', 'feihua', 'theme', 'season', 'dynasty', 'zi', 'workby'];
const GLYPH = ['甲', '乙', '丙', '丁'];
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
    const opts = optionsFor(pool, rng, ans, poem.id, [...poem.c], `本诗第 ${i + 2} 句`);
    if (!opts) return null;
    return {
      prompt: '请选出下一句',
      stem: esc(stem) + '<span class="hint">—— 《' + esc(poem.t) + '》 ' + esc(poem.a) + '</span>',
      answer: ans, options: opts,
      explain: `「${stem}」的下句是「${ans}」——本诗第 ${i + 1}、${i + 2} 句同属一联。`,
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
    const opts = optionsFor(pool, rng, ans, poem.id, [...poem.c], `本诗第 ${i} 句`);
    if (!opts) return null;
    return {
      prompt: '请选出上一句',
      stem: esc(stem) + '<span class="hint">—— 《' + esc(poem.t) + '》 ' + esc(poem.a) + '</span>',
      answer: ans, options: opts,
      explain: `「${ans}」的下一句是「${stem}」——本诗第 ${i}、${i + 1} 句同属一联。`,
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
    const others = segDistractors(pool, rng, gap, poem.id, taken)
      .map((o) => ({ text: o.text, src: `另见于 ${clauseSrc(pool, o.pid, o.text)}` }));
    const opts = shuffleUnique(rng,
      [{ text: ans, src: `本诗第 ${poem.c.indexOf(line) + 1} 句` }, ...others.slice(0, 3)], ans);
    if (!opts) return null;
    return {
      prompt: '补全句中缺字',
      stem: shown + '<span class="hint">—— 《' + esc(poem.t) + '》 ' + esc(poem.a) + '</span>',
      answer: ans, options: opts,
      explain: `原句为「${line}」——本诗第 ${poem.c.indexOf(line) + 1} 句，缺处补「${ans}」。`,
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
    const who = (name, dyn) => `${dyn || '朝代不详'} · 本档收 ${pool.index.authorCount.get(name) || 0} 首`;
    const prof = pool.index.authorMap.get(poem.a);
    const opts = shuffleUnique(rng,
      [{ text: poem.a, src: who(poem.a, poem.d) }, ...chosen.map((a) => ({ text: a.name, src: who(a.name, a.dyn) }))],
      poem.a);
    if (!opts) return null;
    const zi = prof ? `${prof.z ? '，字' + prof.z : ''}${prof.h ? '，号' + prof.h : ''}` : '';
    return {
      prompt: '这首作品出自谁手',
      stem: esc(poem.c[0]) + '<span class="hint">—— 《' + esc(poem.t) + '》</span>',
      answer: poem.a, options: opts,
      explain: `《${poem.t}》作者为${poem.a}（${poem.d}）${zi}，体裁${poem.ty || '不详'}，` +
        `本档共收其 ${pool.index.authorCount.get(poem.a) || 0} 首。`,
    };
  },

  source(pool, rng, poem) {
    if (poem.c.length < 2) return null;
    const alts = pool.index.titles.filter((t) => t.text !== poem.t);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const opts = shuffleUnique(rng,
      [{ text: poem.t, src: `本诗 · ${poem.a}` }, ...chosen.map((t) => ({ text: t.text, src: `${t.au || '佚名'}的作品` }))],
      poem.t);
    if (!opts) return null;
    return {
      prompt: '这几句出自哪首作品',
      stem: esc(poem.c[0]) + '，' + esc(poem.c[1]) + `<span class="hint">—— ${esc(poem.a)} · ${esc(poem.d)}</span>`,
      answer: poem.t, options: opts,
      explain: `出处为《${poem.t}》——${poem.a}（${poem.d}）的${poem.ty || '作品'}，` +
        `首句「${poem.c[0]}」。`,
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
    const opts = shuffleUnique(rng,
      [{ text: ans, src: `本诗第 ${poem.c.indexOf(ans) + 1} 句` },
        ...chosen.map((e) => ({ text: e.text, src: clauseSrc(pool, e.pid, e.text) }))], ans);
    // 四个选项必须都嵌着「ok」，且恰好一句属于本诗
    if (!opts || opts.length < 4 || !opts.every((o) => o.text.includes(ok))) return null;
    return {
      prompt: `飞花令：四句皆含「${ok}」，选出属于本诗的那句`,
      stem: `<strong>《${esc(poem.t)}》</strong> ${esc(poem.a)}` +
        `<span class="hint">—— 下面四句都嵌着「${esc(ok)}」字，哪一句真的出自这首诗</span>`,
      answer: ans, options: opts,
      explain: `「${ans}」是${poem.a}《${poem.t}》的第 ${poem.c.indexOf(ans) + 1} 句；` +
        `其余三句虽同含「${ok}」字，却各有各的出处，逐条列在下面。`,
    };
  },

  theme(pool, rng, poem) {
    if (!poem.th) return null;
    const alts = pool.index.themes.filter((t) => t !== poem.th);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const egOf = (t) => {
      const e = pool.index.themeEg.get(t);
      return e ? `本档《${e.t}》即属此类` : '';
    };
    const opts = shuffleUnique(rng,
      [{ text: poem.th, src: '本诗所属' }, ...chosen.map((t) => ({ text: t, src: egOf(t) }))], poem.th);
    if (!opts) return null;
    // 不露标题：题材靠诗意判断，「送元二使安西」这种题名会直接泄底
    return {
      prompt: '这首诗属于哪一类题材',
      stem: poem.c.slice(0, 4).map(esc).join('<br>'),
      answer: poem.th, options: opts,
      explain: `《${poem.t}》在本库中标为「${poem.th}」类，` +
        `本档共 ${pool.poems.filter((p) => p.th === poem.th).length} 首同标此类；` +
        `首两句为「${poem.c.slice(0, 2).join('，')}」。`,
    };
  },

  season(pool, rng, poem) {
    if (!poem.se) return null;
    const alts = pool.index.seasons.filter((s) => s !== poem.se);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const egOf = (s) => {
      const e = pool.index.seasonEg.get(s);
      return e ? `《${e.t}》同标此季` : '';
    };
    const opts = shuffleUnique(rng,
      [{ text: poem.se, src: '本诗所标' }, ...chosen.map((s) => ({ text: s, src: egOf(s) }))], poem.se);
    if (!opts) return null;
    // 库里只存了季令标签，没存判据词，所以解析说「标为」而不编「因为写了某某」
    return {
      prompt: '诗中写的是哪个季节',
      stem: poem.c.slice(0, 4).map(esc).join('<br>') + '<span class="hint">—— 《' + esc(poem.t) + '》</span>',
      answer: poem.se, options: opts,
      explain: `《${poem.t}》在本库中节令标为「${poem.se}」，` +
        `本档共 ${pool.poems.filter((p) => p.se === poem.se).length} 首同标此季。`,
    };
  },

  dynasty(pool, rng, poem) {
    if (!poem.d) return null;
    const alts = pool.index.dynasties.filter((x) => x !== poem.d);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const egOf = (d) => {
      const e = pool.index.dynEg.get(d);
      const n = pool.index.dynCount.get(d) || 0;
      return e ? `本档 ${n} 首属此代，如 ${e.a}` : `本档 ${n} 首属此代`;
    };
    const opts = shuffleUnique(rng,
      [{ text: poem.d, src: `本诗朝代 · ${poem.a}` }, ...chosen.map((d) => ({ text: d, src: egOf(d) }))], poem.d);
    if (!opts) return null;
    return {
      prompt: '这首作品出自哪个朝代',
      stem: esc(poem.c[0]) + `<span class="hint">—— 《${esc(poem.t)}》 ${esc(poem.a)}</span>`,
      answer: poem.d, options: opts,
      explain: `《${poem.t}》作者${poem.a}，属${poem.d}；` +
        `本档共 ${pool.index.dynCount.get(poem.d) || 0} 首落在${poem.d}。`,
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
    const ownerOf = (x) => {
      const o = pool.index.ziOwner.get(x);
      return o ? `${o.name} 的${o.kind}` : '他人名号';
    };
    const opts = shuffleUnique(rng,
      [{ text: ans, src: `${poem.a} 的${isZi ? '字' : '号'}` }, ...chosen.map((x) => ({ text: x, src: ownerOf(x) }))], ans);
    if (!opts) return null;
    return {
      prompt: isZi ? '这位作者的字是什么' : '这位作者的号是什么',
      stem: esc(poem.c[0]) + `<span class="hint">—— 《${esc(poem.t)}》 ${esc(poem.a)}</span>`,
      answer: ans, options: opts,
      explain: `${poem.a}，字${prof.z || '（失载）'}${prof.h ? '，号' + prof.h : ''}。` +
        `其余三项是本档其他作者的名号，已逐条标出归属。`,
    };
  },

  workby(pool, rng, poem) {
    if (!poem.a) return null;
    const alts = pool.index.titles.filter((t) => t.text !== poem.t && t.au !== poem.a);
    if (alts.length < 3) return null;
    const chosen = shuffled(rng, alts).slice(0, 3);
    const opts = shuffleUnique(rng,
      [{ text: poem.t, src: `${poem.a} 所作 · 本档收 ${pool.index.authorCount.get(poem.a) || 0} 首` },
        ...chosen.map((t) => ({ text: t.text, src: `${t.au || '佚名'} 的作品` }))], poem.t);
    if (!opts) return null;
    return {
      prompt: `下列哪部作品出自${poem.a}之手`,
      stem: `<span class="hint">作者：${esc(poem.a)}（${esc(poem.d)}）</span>`,
      answer: poem.t, options: opts,
      explain: `《${poem.t}》是${poem.a}的作品，本档共收其 ` +
        `${pool.index.authorCount.get(poem.a) || 0} 首。`,
    };
  },
};

function optionsFor(pool, rng, ans, pid, forbid, ansSrc) {
  const n = [...ans].length;
  const taken = new Set([ans, ...forbid]);
  const others = distractors(pool, rng, n, pid, taken)
    .filter((o) => [...o.text].length === n)
    .map((o) => ({ text: o.text, src: clauseSrc(pool, o.pid, o.text) }));
  return shuffleUnique(rng, [{ text: ans, src: ansSrc || '本诗' }, ...others.slice(0, 3)], ans);
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
    uniq.push({ text: t, right: t === ans, src: (typeof item === 'string' ? '' : item.src) || '' });
  }
  if (uniq.length < 4) return null;
  const out = shuffled(rng, uniq);
  if (out.filter((o) => o.right).length !== 1) return null;
  return out;
}

// 池内固定排序：先按必背档位（k=1 小学 → 2 初中 → 3 高中 → 0 扩量诗），
// 同档内按难度分由易到难。周目就是沿这条序列往后挪一段，所以一周目全是课本必背，
// 越往后越扫到同作者的扩量诗；关卡靠后则同一周目内自然变难。
const tierRank = (p) => (p.k > 0 ? p.k : 99);
const rankCmp = (a, b) => tierRank(a) - tierRank(b) || (a.s || 0) - (b.s || 0) || a.id - b.id;

const cyclePlans = new Map();

function cyclePlan(levelKey, cycle, pool) {
  const ck = `${levelKey}:c${cycle}`;
  if (cyclePlans.has(ck)) return cyclePlans.get(ck);
  const lv = LEVELS.find((l) => l.key === levelKey);
  const ranked = pool.poems.slice().sort(rankCmp);
  const n = ranked.length;
  const perCycle = lv.stages * PIN_PER_STAGE;
  const rounds = Math.max(1, Math.ceil(n / perCycle));
  // 首尾相接：池子不能被 perCycle 整除时，最后一周目回头补零头，之后继续轮转复习
  const off = (perCycle * ((cycle - 1) % rounds)) % n;
  const stages = [];
  const pinned = new Set();
  for (let i = 0; i < lv.stages; i++) {
    const four = [];
    for (let j = 0; j < PIN_PER_STAGE; j++) {
      const p = ranked[(off + i * PIN_PER_STAGE + j) % n];
      four.push(p);
      pinned.add(p.id);
    }
    stages.push(four);
  }
  const plan = { stages, pinned, rounds };
  cyclePlans.set(ck, plan);
  return plan;
}

// 随机位刻意避开本周目已经钉过的诗：同周目里再抽到刚考过的只是白占题量，
// 抽没考过的才是净增覆盖。抽取仍只在本档池内，跨档会破坏难度承诺。
function extraPoems(pool, levelKey, cycle, stageIdx, plan, nonce) {
  const rng = mulberry32(hashStr(`${levelKey}:c${cycle}:s${stageIdx}:extra:${nonce}`));
  const want = Q_PER_STAGE - PIN_PER_STAGE;
  const cand = pool.poems.filter((p) => !plan.pinned.has(p.id));
  const from = cand.length >= want ? cand : pool.poems;
  return shuffled(rng, from).slice(0, want);
}

// nonce 每次开新题都由 startStage 现生成：钉死的是「这一关练哪 4 首」，
// 不是「这一关永远是这张卷子」。少了这一层，再来一次会原样重放同一张卷子，
// 读者靠记住选项位置就能连对——正是出题规则里最不该出现的假会。
async function buildStage(levelKey, stageIdx, cycle, nonce) {
  const pool = await loadPool(levelKey);
  const st = lvlState(levelKey);
  if (!cycle) cycle = st.cycle;
  if (!nonce) nonce = freshNonce();
  const plan = cyclePlan(levelKey, cycle, pool);
  const pinned = plan.stages[stageIdx - 1] || [];
  const poems = pinned.concat(extraPoems(pool, levelKey, cycle, stageIdx, plan, nonce));

  // 题型先在本关这一层排好，6 个格子尽量落在不同题型上；
  // 每一格再配一个独立 seed，所以某一格出不了题时 makeQuestion 就地换题型，
  // 不会像共用一条随机流那样，前面多消耗一次就把整关的题面都冲走。
  const kindRng = mulberry32(hashStr(`${levelKey}:c${cycle}:s${stageIdx}:kinds:${nonce}`));
  const kindPlan = shuffled(kindRng, [...KINDS, ...KINDS, ...KINDS]);
  const qs = [];
  poems.forEach((p, slot) => {
    const rng = mulberry32(hashStr(`${levelKey}:c${cycle}:s${stageIdx}:q${slot}:${nonce}`));
    const q = makeQuestion(pool, rng, p, kindPlan[slot % kindPlan.length]);
    if (q) { q.poem = p; qs.push(q); }
  });
  if (qs.length < Q_PER_STAGE) {
    // 兜底：某首诗缺标注、缺同联对句而一种题型都出不了时，按池序补其他诗凑满题量
    for (const p of shuffled(kindRng, pool.poems)) {
      if (qs.length >= Q_PER_STAGE) break;
      if (qs.some((q) => q.poem === p)) continue;
      const rng = mulberry32(hashStr(`${levelKey}:c${cycle}:s${stageIdx}:fix${qs.length}:${nonce}`));
      const q = makeQuestion(pool, rng, p);
      if (q) { q.poem = p; qs.push(q); }
    }
  }
  return { pool, questions: qs, cycle, nonce };
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
    const cleared = stagesCleared(st, lv, st.cycle);
    const card = document.createElement('button');
    card.className = 'level-card';
    card.disabled = true;
    card.innerHTML = `
      <div class="lc-top"><span class="lc-name">${lv.label}</span><span class="lc-tag ${lv.full ? 'full' : ''}">${lv.tag}</span></div>
      <div class="lc-desc">${lv.blurb}</div>
      <div class="lc-meta">
        <span>已通 <b>${cleared}</b>/${lv.stages} 关</span>
        <span>${cycleLabel(st.cycle)}周目</span>
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
      const res = await fetch(`data/${lv.key}.json`, { cache: 'no-cache' });
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
  const cycle = st.cycle;
  let plan = null;
  try { plan = cyclePlan(levelKey, cycle, await loadPool(levelKey)); } catch (e) { /* 题库没到就不写周目进度 */ }
  const gate = gateOf(st, cycle);
  $('#map-title').textContent = `${lv.label} · ${cycleLabel(cycle)}周目`;
  $('#map-summary').textContent = plan
    ? `${lv.blurb}——每关精读 ${PIN_PER_STAGE} 首（本周目内固定），另 ${Q_PER_STAGE - PIN_PER_STAGE} 首随机，` +
      `题型与选项序每次重排。第 ${cycle}/${plan.rounds} 周目，已通 ${stagesCleared(st, lv, cycle)}/${lv.stages} 关`
    : lv.blurb;
  const grid = $('#stages');
  grid.innerHTML = '';
  for (let i = 1; i <= lv.stages; i++) {
    const locked = i > gate;
    const key = sKey(cycle, i);
    const stars = st.stars[key] || 0;
    const best = st.score[key] || 0;
    const b = document.createElement('button');
    b.className = 'stage' + (locked ? ' locked' : '');
    b.innerHTML = `<div class="no">第 ${i} 关</div><div class="nm">${STAGE_NAMES[(i - 1) % STAGE_NAMES.length]}</div>
      <div class="st">${stars ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '未闯'}</div>
      <div class="bs">${best ? best + ' 分' : '—'}</div>`;
    if (!locked) b.onclick = () => startStage(levelKey, i, cycle);
    grid.appendChild(b);
  }
}

async function startStage(levelKey, stageIdx, cycle) {
  // 周目以 buildStage 实际用的那个为准（省略时它会落到存档里的当前周目），
  // 否则 finishStage 会把成绩记到 undefined-N 这种键上，解锁与星级全丢。
  const { pool, questions, cycle: used } = await buildStage(levelKey, stageIdx, cycle);
  if (!questions.length) { alert('该档题库不足以出题'); return; }
  session = {
    levelKey, stageIdx, cycle: used, pool, questions,
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
  GLYPH.forEach((g, idx) => {
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

// 逐项解析：答错的人真正想知道的是「另外三个到底是什么」。
// o.src 全是出题时从索引里直接取回的事实（出处、句序、这个字号是谁的），
// 这里不做任何推断——库里没存题材/季令的判据词，所以也不写「因为写了某物」。
function optionNotes(q, choiceIdx) {
  return q.options.map((o, i) => {
    const tags = [];
    if (o.right) tags.push('<em class="on-tag ok">正确</em>');
    if (i === choiceIdx) tags.push(`<em class="on-tag ${o.right ? 'ok' : 'bad'}">你选的</em>`);
    return `<div class="ono${o.right ? ' ok' : ''}${i === choiceIdx ? ' chose' : ''}">` +
      `<span class="gi">${GLYPH[i]}</span>` +
      `<span class="on-t">${esc(o.text)}${tags.join('')}</span>` +
      `<span class="on-s">${esc(o.src || '—')}</span></div>`;
  }).join('');
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
  $('#reveal-opts').innerHTML = optionNotes(q, choiceIdx);
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
  const { levelKey, stageIdx, cycle, correct } = session;
  const cleared = correct >= PASS_LINE;
  const stars = !cleared ? 0 : correct >= 6 ? 3 : correct >= 5 ? 2 : 1;
  const lv = LEVELS.find((l) => l.key === levelKey);
  const st = lvlState(levelKey);
  const key = sKey(cycle, stageIdx);

  st.stars[key] = Math.max(st.stars[key] || 0, stars);
  st.score[key] = Math.max(st.score[key] || 0, session.score);
  if (cleared && stageIdx + 1 <= lv.stages) openGate(st, cycle, stageIdx + 1);
  progress.best = Math.max(progress.best || 0, session.score);
  // 本周目最后一关也通了就自动开下一周目：题目换成池子里往后的一段，读者不必手动挑
  const swept = cleared && stagesCleared(st, lv, cycle) >= lv.stages;
  if (swept) st.cycle = cycle + 1;
  saveProgress();

  show('result');
  $('#result-seal').textContent = cleared ? (stars === 3 ? '状元' : '及第') : '下第';
  $('#result-seal').classList.toggle('fail', !cleared);
  $('#result-stars').textContent = cleared ? '★★★'.slice(0, stars) + `☆`.repeat(3 - stars) : '☆☆☆';
  $('#result-title').textContent = cleared
    ? `${lv.label} ${cycleLabel(cycle)}周目 第 ${stageIdx} 关通过`
    : `${lv.label} ${cycleLabel(cycle)}周目 第 ${stageIdx} 关未通过`;
  $('#result-sub').textContent = cleared
    ? (swept
        ? `${cycleLabel(st.cycle)}周目开启——同一关号会考另一组诗`
        : stageIdx < lv.stages ? `第 ${stageIdx + 1} 关已解锁` : '这一档的全部关卡都已踏平')
    : `本关需答对 ${PASS_LINE} 题，再试一次`;

  const accuracy = Math.round((correct / session.questions.length) * 100);
  $('#result-stats').innerHTML = `
    <div><b>${session.score}</b>得分</div>
    <div><b>${correct}/${session.questions.length}</b>答对</div>
    <div><b>${accuracy}%</b>正确率</div>`;

  const nextBtn = $('#btn-continue');
  nextBtn.style.display = cleared ? '' : 'none';
  if (swept) {
    nextBtn.textContent = '进入下一周目 →';
    nextBtn.onclick = () => startStage(levelKey, 1, st.cycle);
  } else if (stageIdx < lv.stages) {
    nextBtn.textContent = '下一关 →';
    nextBtn.onclick = () => startStage(levelKey, stageIdx + 1, cycle);
  }
  $('#btn-retry').onclick = () => startStage(levelKey, stageIdx, cycle);
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

/* -------------------------------------------------------------- 分档书目 */

// k 是「命中的必背清单档位」。实测各池分布：小学池只有 1，初中池 1/2，高中池 1/2/3，
// 大学与全量池为 0（清单外）——所以「必背」标记只在前三个档位有意义。
const CANON_LABEL = { 1: '小学必背', 2: '初中必背', 3: '高中必背' };
const LIST_BATCH = 200;
const BODY_LINES = 40; // 全量档有 113 句的长诗，列表里只摊开前 40 句

const tierView = { key: 'primary', poolKey: null, q: '', dyn: '', type: '', canonOnly: false, rows: [], shown: 0 };

function poemRowHTML(p) {
  const badge = p.k > 0 ? `<span class="pr-badge">${CANON_LABEL[p.k] || '必背'}</span>` : '';
  const clauses = p.c || [];
  const body = clauses.slice(0, BODY_LINES).map(esc).join('<br>');
  const cut = clauses.length > BODY_LINES
    ? `<br><span class="pr-omit">…… 全篇 ${clauses.length} 句，此处只列前 ${BODY_LINES} 句</span>` : '';
  return `<div class="poem-row"><div class="pr-head">` +
    `<span class="pr-t">《${esc(p.t)}》</span>` +
    `<span class="pr-a">${esc(p.a)} · ${esc(p.d)} · ${esc(p.ty || '其他')}</span>${badge}</div>` +
    `<div class="pr-body">${body}${cut}</div></div>`;
}

// API 返回的是长字段名，套进同一个渲染器，两个界面的行样式才能一致。
const apiPoemRow = (p) => poemRowHTML({
  t: p.title, a: p.author?.name || '佚名', d: p.dynasty?.name || '—',
  ty: p.type?.name, c: p.content || [], k: 0,
});

function renderTierTabs() {
  const box = $('#tiers-tabs');
  box.innerHTML = '';
  for (const lv of LEVELS) {
    const b = document.createElement('button');
    b.textContent = lv.label;
    b.classList.toggle('on', lv.key === tierView.key);
    b.onclick = () => openTiers(lv.key);
    box.appendChild(b);
  }
}

async function openTiers(key) {
  show('tiers');
  tierView.key = key || tierView.key;
  renderTierTabs();
  $('#tiers-count').textContent = '载入本档书目…';
  let pool;
  try {
    pool = await loadPool(tierView.key);
  } catch (e) {
    // 题库 JSON 是静态文件，取不到就是部署缺文件或路径错了；
    // 卡在「载入中」会让人以为是网络慢。
    $('#tiers-count').innerHTML = `<div class="notice">本档题库取不到（${esc(String(e.message || e))}）。` +
      `这一档的书目需要 <code>data/${esc(tierView.key)}.json</code>，闯关同样需要它。</div>`;
    $('#tiers-list').innerHTML = '';
    $('#tiers-more').hidden = true;
    return;
  }

  // 换档时朝代/体裁的候选集就变了，留着旧选择会筛出一张空表
  if (tierView.poolKey !== pool.key) {
    tierView.poolKey = pool.key;
    tierView.dyn = ''; tierView.type = ''; tierView.canonOnly = false;
    $('#tiers-canon').checked = false;
    const opts = (vals, label) => [`<option value="">${label}</option>`]
      .concat(vals.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)).join('');
    $('#tiers-dyn').innerHTML = opts([...new Set(pool.poems.map((p) => p.d).filter(Boolean))], '全部朝代');
    $('#tiers-type').innerHTML = opts([...new Set(pool.poems.map((p) => p.ty).filter(Boolean))], '全部体裁');
    $('#tiers-q').value = ''; tierView.q = '';
  }
  $('#tiers-sum').textContent = `${pool.label} · 本档收录 ${pool.shipped} 首`;
  applyTierFilters();
}

function applyTierFilters() {
  const pool = poolCache.get(tierView.key);
  if (!pool) return; // 本档 JSON 没取到，筛选控件此时没有可筛的数据
  const q = tierView.q.trim();
  tierView.rows = pool.poems.filter((p) =>
    (!tierView.canonOnly || p.k > 0) &&
    (!tierView.dyn || p.d === tierView.dyn) &&
    (!tierView.type || p.ty === tierView.type) &&
    (!q || `${p.t || ''}${p.a || ''}${(p.c || []).join('')}`.includes(q)));
  tierView.shown = 0;
  $('#tiers-list').innerHTML = '';
  const anyFilter = !!(q || tierView.dyn || tierView.type || tierView.canonOnly);
  $('#tiers-clear').hidden = !anyFilter;
  appendTierBatch();
}

function appendTierBatch() {
  const batch = tierView.rows.slice(tierView.shown, tierView.shown + LIST_BATCH);
  $('#tiers-list').insertAdjacentHTML('beforeend', batch.map(poemRowHTML).join(''));
  tierView.shown += batch.length;

  const left = tierView.rows.length - tierView.shown;
  const more = $('#tiers-more');
  more.hidden = left <= 0;
  more.textContent = `加载更多（还有 ${left} 首）`;

  const canonN = tierView.rows.reduce((n, p) => n + (p.k > 0 ? 1 : 0), 0);
  $('#tiers-count').innerHTML = tierView.rows.length
    ? `筛出 <b>${tierView.rows.length}</b> 首（必背 ${canonN} 首），已显示 ${tierView.shown} 首`
    : '没有符合条件的诗，换个关键词或放宽筛选';
}

/* -------------------------------------------------------------- 全库检索 */

// 服务端约束（internal/api/rest/handler/pagination.go）：page_size ≤ 100，
// 页码翻页的 offset ≤ 10000，超深只能走游标（?after=），所以朝代分组用游标、
// 搜索结果用页码并如实告诉用户翻到哪儿断了。
const LIB_BATCH = 30;
const LIB_MAX_OFFSET = 10000;

const lib = { lang: 'zh-Hans', field: 'all', q: '', dynasties: null, panels: new Map(), search: null };

async function apiJSON(path, params) {
  const u = new URL(path, location.href);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) u.searchParams.set(k, String(v));
  const res = await fetch(u);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (e) { /* 非 JSON 的错误页 */ }
    throw new Error(`${res.status}${detail ? ' · ' + detail : ''}`);
  }
  return res.json();
}

const panelOf = (id) => {
  if (!lib.panels.has(id)) lib.panels.set(id, { open: false, items: [], cursor: null, hasMore: true, total: 0, loading: false, error: '' });
  return lib.panels.get(id);
};

const spanYears = (d) => {
  const fmt = (y) => (y == null ? null : y < 0 ? `前${Math.abs(y)}` : String(y));
  const a = fmt(d.start_year), b = fmt(d.end_year);
  return a || b ? `${a ?? '?'} — ${b ?? '?'}` : '年代不详';
};

async function openLibrary() {
  show('library');
  // 输入框里还留着上次的关键词时，重进界面不该退回分组视图——
  // 那会让「检索「月」」的标题和下面的朝代列表自相矛盾。
  if (lib.dynasties) {
    if (lib.q.trim()) { if (!lib.search) runSearch(false); else paintSearch(); }
    else renderGroups();
    return;
  }
  $('#lib-count').textContent = '正在读取朝代…';
  try {
    lib.dynasties = (await apiJSON('/api/v1/dynasties', {})).data;
  } catch (e) {
    $('#lib-count').innerHTML = `<div class="notice">朝代列表取不到（${esc(String(e.message))}）。` +
      `全库检索依赖诗词 API，<b>闯关不受影响</b>；启动 chinese-poetry-api 后重新点开即可。<br>` +
      `也可以在本地跑 chinese-poetry-api（默认 :1279），再由 serve.mjs 代理到 /api。</div>`;
    $('#lib-body').innerHTML = '';
    $('#lib-more').hidden = true;
    return;
  }
  renderGroups();
}

function renderGroups() {
  $('#lib-more').hidden = true;
  const sum = lib.dynasties.reduce((n, d) => n + (d.poem_count || 0), 0);
  $('#lib-sum').textContent = `${lib.dynasties.length} 个朝代分组`;
  $('#lib-count').innerHTML = `按朝代分组浏览 · 分朝代合计 <b>${sum.toLocaleString()}</b> 首 · ` +
    `点开朝代即取该朝代前 ${LIB_BATCH} 首`;
  $('#lib-body').innerHTML = lib.dynasties.map((d) => {
    const p = panelOf(d.id);
    return `<div class="grp${p.open ? ' open' : ''}" id="grp-${d.id}">` +
      `<div class="grp-head" data-grp="${d.id}">` +
      `<span class="grp-name">${esc(d.name)}</span>` +
      `<span class="grp-meta">${(d.poem_count || 0).toLocaleString()} 首 · ${(d.author_count || 0).toLocaleString()} 位作者 · ${esc(spanYears(d))}</span>` +
      `<span class="grp-toggle">${p.open ? '收起' : '展开'}</span></div>` +
      `<div class="grp-body" id="gb-${d.id}">${panelBody(d.id)}</div></div>`;
  }).join('');
}

function panelBody(id) {
  const p = panelOf(id);
  if (p.loading && !p.items.length) return '<div class="list-count">载入中…</div>';
  if (p.error) return `<div class="notice">这一组取不到（${esc(p.error)}）。</div>`;
  if (!p.items.length) return '<div class="list-count">该朝代没有可展示的诗词。</div>';
  const rows = p.items.map(apiPoemRow).join('');
  const status = `<div class="list-count">已加载 <b>${p.items.length}</b> / ${(p.total || 0).toLocaleString()} 首</div>`;
  const btn = p.hasMore
    ? `<button class="ghost more" data-grp-more="${id}">加载更多</button>`
    : '<div class="list-count">这一组已经翻到底了</div>';
  return `<div class="poem-list">${rows}</div>${status}${btn}`;
}

function paintPanel(id) {
  const box = document.getElementById(`gb-${id}`);
  if (box) box.innerHTML = panelBody(id);
  const head = document.querySelector(`#grp-${id} .grp-toggle`);
  if (head) head.textContent = panelOf(id).open ? '收起' : '展开';
}

async function loadGroup(id, more) {
  const p = panelOf(id);
  if (p.loading || (more && !p.hasMore)) return;
  p.loading = true;
  p.error = '';
  const token = (p.token = Symbol());
  const params = { dynasty_id: id, page_size: LIB_BATCH, lang: lib.lang };
  if (more) params.after = p.cursor;
  try {
    const j = await apiJSON('/api/v1/poems', params);
    if (p.token !== token) return; // 语言切过时留下的迟到响应
    p.items = p.items.concat(j.data);
    p.total = j.pagination.total;
    p.cursor = j.pagination.next_cursor || null;
    p.hasMore = !!j.pagination.has_next_page;
  } catch (e) {
    if (p.token !== token) return;
    p.error = String(e.message || e);
  } finally {
    p.loading = false;
    if (p.token === token) paintPanel(id);
  }
}

function toggleGroup(id) {
  const p = panelOf(id);
  p.open = !p.open;
  document.getElementById(`grp-${id}`)?.classList.toggle('open', p.open);
  paintPanel(id);
  if (p.open && !p.items.length && !p.loading) loadGroup(id, false);
}

async function runSearch(more) {
  if (!more) lib.search = { items: [], page: 0, total: 0, done: false, loading: false, error: '' };
  const s = lib.search;
  if (!s || s.loading) return;
  if (more && (s.done || s.page * LIB_BATCH >= LIB_MAX_OFFSET)) return;
  s.loading = true;
  s.error = '';
  const token = (s.token = Symbol());
  const page = s.page + 1;
  try {
    const j = await apiJSON('/api/v1/poems/search',
      { q: lib.q.trim(), type: lib.field, page, page_size: LIB_BATCH, lang: lib.lang });
    if (s.token !== token) return;
    s.items = s.items.concat(j.data);
    s.page = page;
    s.total = j.pagination.total;
    s.done = s.items.length >= s.total;
  } catch (e) {
    if (s.token !== token) return;
    s.error = String(e.message || e);
  } finally {
    s.loading = false;
    if (s.token === token) paintSearch();
  }
}

function paintSearch() {
  const s = lib.search;
  const q = lib.q.trim();
  if (!s) return;
  $('#lib-sum').textContent = `检索「${q}」`;
  if (s.error) {
    $('#lib-count').innerHTML = `<div class="notice">检索失败（${esc(s.error)}）。` +
      `关键词太短或 API 未启动时会出现这个提示。</div>`;
    $('#lib-body').innerHTML = '';
    $('#lib-more').hidden = true;
    return;
  }
  if (!s.items.length && s.page === 0) { $('#lib-count').textContent = '检索中…'; return; }

  const capped = !s.done && s.page * LIB_BATCH >= LIB_MAX_OFFSET;
  $('#lib-count').innerHTML = s.items.length
    ? `命中 <b>${s.total.toLocaleString()}</b> 首 · 已显示 ${s.items.length} 首` +
      (capped ? `<br>页码翻页最深只到 ${LIB_MAX_OFFSET.toLocaleString()} 条，再往里请缩小关键词` : '')
    : `「${esc(q)}」在全库里没有命中`;
  $('#lib-body').innerHTML = s.items.length
    ? `<div class="poem-list">${s.items.map(apiPoemRow).join('')}</div>` : '';
  const more = $('#lib-more');
  more.hidden = !(s.items.length && !s.done && !capped);
  more.textContent = `加载更多（还有 ${(s.total - s.items.length).toLocaleString()} 首）`;
}

function submitLibraryQuery(force) {
  const val = $('#lib-q').value;
  if (!force && val === lib.q) return;
  lib.q = val;
  lib.search = null;
  $('#lib-more').hidden = true;
  if (!lib.q.trim()) { renderGroups(); return; }
  $('#lib-body').innerHTML = '';
  $('#lib-count').textContent = '检索中…';
  runSearch(false);
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

$('#btn-open-tiers').onclick = () => openTiers(tierView.key);
$('#btn-open-library').onclick = () => openLibrary();
$('#tiers-more').onclick = appendTierBatch;

let tierTimer = null;
$('#tiers-q').addEventListener('input', (e) => {
  clearTimeout(tierTimer);
  const v = e.target.value;
  tierTimer = setTimeout(() => { tierView.q = v; applyTierFilters(); }, 220);
});
$('#tiers-dyn').onchange = (e) => { tierView.dyn = e.target.value; applyTierFilters(); };
$('#tiers-type').onchange = (e) => { tierView.type = e.target.value; applyTierFilters(); };
$('#tiers-canon').onchange = (e) => { tierView.canonOnly = e.target.checked; applyTierFilters(); };
$('#tiers-clear').onclick = () => {
  clearTimeout(tierTimer); // 否则上一个输入框的延迟回调会把旧关键词再填回来
  Object.assign(tierView, { q: '', dyn: '', type: '', canonOnly: false });
  $('#tiers-q').value = ''; $('#tiers-dyn').value = ''; $('#tiers-type').value = '';
  $('#tiers-canon').checked = false;
  applyTierFilters();
};
$('#tiers-list').addEventListener('click', (e) => {
  const h = e.target.closest('.pr-head');
  if (h) h.parentElement.classList.toggle('open');
});

let libTimer = null;
$('#lib-q').addEventListener('input', () => { clearTimeout(libTimer); libTimer = setTimeout(() => submitLibraryQuery(), 400); });
$('#lib-q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  clearTimeout(libTimer);
  submitLibraryQuery(true);
});
$('#lib-field').onchange = (e) => {
  lib.field = e.target.value;
  if (lib.q.trim()) { lib.search = null; $('#lib-body').innerHTML = ''; runSearch(false); }
};
$('#lib-lang').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.lang === lib.lang) return;
  lib.lang = b.dataset.lang;
  $$('#lib-lang button').forEach((x) => x.classList.toggle('on', x === b));
  lib.panels.clear(); // 繁简是两张表，已加载的行不能用新表的结果混着翻页
  lib.search = null;
  if (lib.q.trim()) { $('#lib-body').innerHTML = ''; runSearch(false); } else renderGroups();
});
$('#lib-more').onclick = () => runSearch(true);
$('#lib-body').addEventListener('click', (e) => {
  const more = e.target.closest('[data-grp-more]');
  if (more) { loadGroup(more.dataset.grpMore, true); return; }
  const head = e.target.closest('.grp-head');
  if (head) { toggleGroup(head.dataset.grp); return; }
  const pr = e.target.closest('.pr-head');
  if (pr) pr.parentElement.classList.toggle('open');
});

$$('[data-go]').forEach((b) => (b.onclick = () => {
  if (b.dataset.go === 'home') renderHome(), show('home'), syncCorpus(), loadDaily();
  else openMap(session?.levelKey || 'primary');
}));

renderHome();
show('home');
syncCorpus();
loadDaily();
