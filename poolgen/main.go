package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"database/sql"
	_ "github.com/mattn/go-sqlite3"
)

// 每个难度档的配置。
//
// 低三档（小学/初中/高中）由必背清单驱动：档位内容就是课本古诗文，
// 清单之外再从同一批作者的作品里补足题量。用清单而不是难度分，
// 是因为「小学档太简单以至于没人读过」这件事难度分测不出来——
// 宋人的浅语小作字字都认得，分数极低，可它不是课本内容。
//
// 大学档没有清单可依，回到难度分位带：取全库最难的那一段。
// 全量档不设门槛，随机抽样，保留语料的真实构成。
type levelCfg struct {
	Key           string
	Label         string
	Target        int
	BandLo        float64 // 难度分位下界 0-1
	BandHi        float64 // 难度分位上界 0-1
	MaxLines      int
	MaxTypeW      float64
	AllowNote     bool
	NeatLines     bool // 要求句式齐整（五七言区间）
	MaxPerAu      int  // 单个作者在该档的题量上限
	TopAu         int  // 该档只从知名度前 N 的作者里取题
	Full          bool // 不设门槛，全库随机抽样
	Canon         int  // 必背清单档位，0 表示该档不走清单
	CanonMaxLines int  // 清单诗另设的行数上限，比 MaxLines 宽松
	MinCharDF     int  // 扩池诗（清单外）里最生僻字的文档频率下限，挡住异体字与僻诗
}

var levels = []levelCfg{
	{Key: "primary", Label: "小学", Target: 260, MaxLines: 8, MaxTypeW: 0.22,
		NeatLines: true, MaxPerAu: 5, Canon: tierPrimary, CanonMaxLines: 16, MinCharDF: 80},
	{Key: "junior", Label: "初中", Target: 420, MaxLines: 12, MaxTypeW: 0.56,
		MaxPerAu: 5, Canon: tierJunior, CanonMaxLines: 28, MinCharDF: 80},
	{Key: "senior", Label: "高中", Target: 560, MaxLines: 20, MaxPerAu: 6,
		Canon: tierSenior, CanonMaxLines: 40, MinCharDF: 80},
	{Key: "college", Label: "大学", Target: 600, BandLo: 0.45, BandHi: 1.00, MaxLines: 48,
		AllowNote: true, MaxPerAu: 6, TopAu: 220},
	{Key: "full", Label: "全量", Target: 1200, AllowNote: true, MaxPerAu: 4, Full: true},
}

type poem struct {
	ID    int64    `json:"id"`
	Title string   `json:"t"`
	Lines []string `json:"c"`
	Auth  string   `json:"a"`
	Dyn   string   `json:"d"`
	Type  string   `json:"ty"`

	clauses []string // 与 Lines 相同，保留名字给老代码
	term    []byte   // 每句终止符：'d'=句号级（。！？），'c'=句内（，、；）
	grp     []int    // 每句属于原始 content 数组的第几段（联/片）
	theme   string
	season  string

	avgLen      float64
	charDiff    float64
	lengthScore float64
	typeW       float64
	obscurity   float64
	fame        float64 // 作者产量算出的粗略知名度
	rankLog     float64 // 搜索引擎结果量的 log10，0 表示没有记录
	fameP       float64 // rankLog 在全库里的分位
	canonTier   int     // 命中的必背清单档位，0 表示清单之外
	minDF       int     // 诗中最生僻字的文档频率，用于把异体字/生僻诗挡在课本档位外
	score       float64
}

type outPoem struct {
	ID    int64    `json:"id"`
	Title string   `json:"t"`
	Lines []string `json:"c"`
	Auth  string   `json:"a"`
	Dyn   string   `json:"d"`
	Type  string   `json:"ty"`
	Theme string   `json:"th,omitempty"`
	Seas  string   `json:"se,omitempty"`
	Term  string   `json:"p,omitempty"` // 与 Lines 等长，'d'/'c'
	Grp   string   `json:"g,omitempty"` // 与 Lines 等长，base36 段号
	Score float64  `json:"s"`
	Fame  float64  `json:"f"`           // 知名度分位，只用于日志与调参
	Canon int      `json:"k,omitempty"` // >0 表示课本必背篇目，前端优先出题
}

type outAuthor struct {
	Name string `json:"n"`
	Dyn  string `json:"d"`
	Zi   string `json:"z,omitempty"`
	Hao  string `json:"h,omitempty"`
}

type outLevel struct {
	Key      string      `json:"key"`
	Label    string      `json:"label"`
	Eligible int         `json:"eligible"`
	Shipped  int         `json:"shipped"`
	ScoreLo  float64     `json:"score_lo"`
	ScoreHi  float64     `json:"score_hi"`
	Poems    []outPoem   `json:"poems"`
	Authors  []outAuthor `json:"authors"`
}

// 体裁难度权重：体裁越古、越格律化、越长篇，权重越高。
var typeWeight = map[string]float64{
	"五言绝句": 0.10, "七言绝句": 0.15, "唐诗": 0.20, "蒙学": 0.15,
	"五言律诗": 0.30, "七言律诗": 0.35, "五言古诗": 0.42, "七言古诗": 0.44,
	"乐府诗": 0.52, "宋词": 0.52, "五代词": 0.56, "论语": 0.60,
	"元曲": 0.68, "四书五经": 0.70, "诗经": 0.72, "楚辞": 0.75, "其他": 0.82,
}

// segment 是拆出来的一句，带终止符性质与所属段落号。
type segment struct {
	text string
	dot  bool // 句末是句号级标点（。！？；外的句终）
	grp  int  // 属于原始 content 数组的第几段：律诗一段一联，词一段一阕
}

// splitSegments 把 JSON 诗句数组切成单句，并保留「这句后面是逗号还是句号」。
//
// 前端考「接下句」时必须知道这个信息：跨句号、跨阕的上下句要靠记忆整首背诵，
// 同一联里的出句对句则能凭对仗与押韵推出来，两者难度完全不是一级。
// 原先标点被直接丢掉，这个信息就没了。
func splitSegments(raw string) []segment {
	var lines []string
	if err := json.Unmarshal([]byte(raw), &lines); err != nil {
		return nil
	}
	out := make([]segment, 0, len(lines)*2)
	for gi, ln := range lines {
		// 去掉 [1]、[27] 这类校注角标，避免污染题面
		runes := []rune(dropNotes(ln))
		if txt, dot, rest, ok := cutRedup(runes); ok {
			out = append(out, segment{text: txt, dot: dot, grp: gi})
			runes = rest
		}
		var buf []rune
		flush := func(dot bool) {
			if n := len(buf); n >= 3 && n <= 20 {
				out = append(out, segment{text: string(buf), dot: dot, grp: gi})
			}
			buf = buf[:0]
		}
		for _, r := range runes {
			if isSegPunct(r) {
				flush(isDotPunct(r))
				continue
			}
			if unicode.IsSpace(r) {
				continue
			}
			buf = append(buf, r)
		}
		flush(true)
	}
	return out
}

// cutRedup 把叠字起句整段收成一句：「鹅，鹅，鹅，曲项向天歌」的开头是「鹅鹅鹅」，
// 不是三个孤立的「鹅」。按标点切完再套 3 字下限，《咏鹅》就只剩「曲项向天歌」起头，
// 课本里那首诗等于少了第一句。
func cutRedup(line []rune) (text string, dot bool, rest []rune, ok bool) {
	if len(line) < 5 || !isHan(line[0]) {
		return "", false, line, false
	}
	i, n := 1, 1
	for i+1 < len(line) && isSegPunct(line[i]) && !isDotPunct(line[i]) && line[i+1] == line[0] {
		n++
		i += 2
	}
	if n < 3 {
		return "", false, line, false
	}
	if i >= len(line) {
		return strings.Repeat(string(line[0]), n), true, nil, true
	}
	return strings.Repeat(string(line[0]), n), isDotPunct(line[i]), line[i+1:], true
}

// 句子最短 3 字、最长 20 字：再短的是叠字或残字，再长的是排版没拆开的整段。
func isSegPunct(r rune) bool {
	return unicode.IsPunct(r) || strings.ContainsRune("《》「」『』、。，；：？！－—…·（）()【】", r)
}

func isDotPunct(r rune) bool {
	return strings.ContainsRune("。！？；", r)
}

// splitClauses 只要文本，供字频统计与旧代码使用。
func splitClauses(raw string) []string {
	segs := splitSegments(raw)
	out := make([]string, 0, len(segs))
	for _, s := range segs {
		out = append(out, s.text)
	}
	return out
}

func dropNotes(s string) string {
	var b strings.Builder
	inNote := false
	for _, r := range s {
		switch {
		case r == '[':
			inNote = true
		case r == ']':
			inNote = false
		case !inNote:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func splitOnPunct(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		return unicode.IsPunct(r) || unicode.IsSpace(r) ||
			strings.ContainsRune("《》「」『』、。，；：？！－—…·（）()【】", r)
	})
}

func main() {
	// 默认路径按「在 poolgen/ 目录里 go run .」算；在别的目录跑要显式传 -db/-rank/-out。
	dbPath := flag.String("db", "../../chinese-poetry-api/data/poetry.db", "poetry.db 路径")
	outDir := flag.String("out", "../public/data", "题库输出目录")
	rankDir := flag.String("rank", "../../chinese-poetry-api/poetry-data/rank", "知名度数据 rank/ 目录")
	probe := flag.Int("probe", 0, "打印指定档位里知名度最高的前 N 首，用于人工核对难度是否合适")
	showCanon := flag.Bool("canon", false, "打印必背清单与库内题名的核对报告")
	canonAmb := flag.Bool("canonamb", false, "配合 -canon：打印同题多首、需要补首句锚点的清单条目")
	dumpAu := flag.String("dumpauthor", "", "调试：打印该作者存活到题库里的全部题名")
	residue := flag.Bool("residue", false, "量一量入库文本里还剩多少个非简体字（t2s 转换后与自身不同的字）")
	flag.Parse()

	db, err := sql.Open("sqlite3", "file:"+*dbPath+"?mode=ro&_journal_mode=WAL")
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	log.Println("读取知名度数据 rank/")
	fame, err := loadFame(*rankDir)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("知名度记录 %d 条", len(fame))

	// 第一遍：统计每个汉字出现在多少首诗里（文档频率）。
	// 语料级字频是本应用"生僻度"的唯一客观依据，不靠人工词表。
	log.Println("pass 1: 统计全语料字频")
	df := map[rune]int{}
	maxDF := 1
	if err := scanPoems(db, func(raw string) {
		seen := map[rune]bool{}
		for _, r := range raw {
			if isHan(r) {
				seen[r] = true
			}
		}
		for r := range seen {
			df[r]++
			if df[r] > maxDF {
				maxDF = df[r]
			}
		}
	}); err != nil {
		log.Fatal(err)
	}
	log.Printf("不重复汉字 %d 个，最高文档频率 %d", len(df), maxDF)

	// 单字生僻度：log 压缩后的文档频率取反，出现越少的字越难。
	log10Max := math.Log10(float64(maxDF) + 1)
	charHard := func(r rune) float64 {
		f := math.Log10(float64(df[r])+1) / log10Max
		return 1 - f
	}

	// 第二遍：逐首算指标。
	log.Println("pass 2: 计算每首诗的难度指标")
	var all []*poem
	seenTitled := map[string]bool{}
	authorCount := map[string]int{}
	profiles := map[string]outAuthor{}

	err = eachPoem(db, func(r row) {
		r.raw = fixVariant(r.raw)
		r.title = fixVariant(r.title)
		r.author = fixVariant(r.author)
		segs := splitSegments(r.raw)
		clauses := make([]string, 0, len(segs))
		for _, s := range segs {
			clauses = append(clauses, s.text)
		}
		if len(clauses) < 2 || len(clauses) > 130 {
			return
		}
		title := cleanTitle(r.title)
		// 脱文占位方框和《全唐诗》辑佚残句不能出题：题面会出现 □，
		// 残句则短到没有上下文可考。
		if title == "" || !usable(title, clauses) {
			return
		}
		r.title = title

		joined := strings.Join(clauses, "")
		// 去重只按「作者 + 题名 + 首句」。不能按正文去重：
		// 《登鹳雀楼》全唐诗里同时挂在王之涣和朱斌《登楼》名下，正文一字不差，
		// 按正文去重会把后扫到的王之涣那份丢掉，必背清单反而点不到名。
		// 跨作者的同文诗留给前端 shuffleUnique 在选项层面去重。
		dupeKey := normKey(r.author) + "\x00" + normKey(r.title) + "\x00" + clauses[0]
		if seenTitled[dupeKey] || strings.Contains(r.title, "[") {
			return
		}
		seenTitled[dupeKey] = true

		var sumHard float64
		total := 0
		runes := 0
		minDF := 1 << 30
		for _, c := range clauses {
			runes += len([]rune(c))
			for _, cr := range c {
				if isHan(cr) {
					sumHard += charHard(cr)
					total++
					if df[cr] < minDF {
						minDF = df[cr]
					}
				}
			}
		}
		if total == 0 {
			return
		}
		p := &poem{
			ID: r.id, Title: r.title, Lines: clauses,
			Auth: r.author, Dyn: r.dyn, Type: r.tname, clauses: clauses,
			charDiff: sumHard / float64(total),
			avgLen:   float64(runes) / float64(len(clauses)),
			term:     make([]byte, len(segs)),
			grp:      make([]int, len(segs)),
			theme:    classifyTheme(r.title, joined),
			season:   classifySeason(joined),
			rankLog:  fame[fameKey(r.author, r.title)],
			minDF:    minDF,
		}
		for i, s := range segs {
			if s.dot {
				p.term[i] = 'd'
			} else {
				p.term[i] = 'c'
			}
			p.grp[i] = s.grp
		}
		if _, ok := profiles[authorKey(r.author, r.dyn)]; !ok && r.author != "" {
			zi, hao := extractZiHao(r.bio)
			profiles[authorKey(r.author, r.dyn)] = outAuthor{Name: r.author, Dyn: r.dyn, Zi: zi, Hao: hao}
		}
		p.lengthScore = math.Min(float64(total)/60.0, 1)
		p.typeW = typeWeight[r.tname]
		if p.typeW == 0 {
			p.typeW = 0.5
		}
		authorCount[r.author]++
		all = append(all, p)
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("可用诗 %d 首（已去重、去残句）", len(all))

	if *dumpAu != "" {
		for _, p := range all {
			if p.Auth == *dumpAu {
				fmt.Printf("  %q 句=%d\n", p.Title, len(p.clauses))
			}
		}
		return
	}

	// 知名度分位：只有 rank/ 里有记录的诗参与排名，没有记为一律 0 分位。
	// 用分位而不是原始计数，是因为五个引擎的量纲差了几百倍。
	{
		type fr struct {
			idx   int
			rankL float64
		}
		var withFame []fr
		for i, p := range all {
			if p.rankLog > 0 {
				withFame = append(withFame, fr{i, p.rankLog})
			}
		}
		sort.Slice(withFame, func(i, j int) bool { return withFame[i].rankL < withFame[j].rankL })
		n := len(withFame)
		log.Printf("能对上有名有姓的 rank 记录 %d 首（占 %.1f%%）", n, float64(n)/float64(len(all))*100)
		for i, e := range withFame {
			all[e.idx].fameP = float64(i) / float64(n)
		}
		for _, q := range []float64{0.50, 0.80, 0.90, 0.95, 0.99} {
			i := int(q * float64(n-1))
			log.Printf("知名度分位 P%.0f：log10 结果数 %.2f（约 %s 条）", q*100, withFame[i].rankL, humanCount(withFame[i].rankL))
		}
	}

	// 作者知名度：传世作品越多，通常越是课本常客。
	maxAuthor := 1
	for _, n := range authorCount {
		if n > maxAuthor {
			maxAuthor = n
		}
	}
	log10A := math.Log10(float64(maxAuthor) + 1)
	for _, p := range all {
		p.obscurity = 1 - math.Log10(float64(authorCount[p.Auth])+1)/log10A
		p.fame = math.Log10(float64(authorCount[p.Auth])+1) / log10A
		if !isPersonal(p.Auth) {
			// 「无名氏」「郊庙朝会歌辞」是把成批作品归到一个条目下的合集名，
			// 收录量大自然知名度虚高，但它们不对应任何可考的诗人。
			p.fame *= 0.12
		}
		p.score = 0.42*p.charDiff + 0.26*p.lengthScore + 0.20*p.typeW + 0.12*p.obscurity
	}

	sort.Slice(all, func(i, j int) bool { return all[i].score < all[j].score })
	for _, q := range []float64{0.05, 0.12, 0.30, 0.58, 0.90, 0.99} {
		i := int(q * float64(len(all)-1))
		fmt.Printf("难度分 P%-5.0f = %.3f\n", q*100, all[i].score)
	}

	// 必背清单标注。assignCanon 往 p.canonTier 写值，必须在 selectLevel 之前跑完。
	// 清单在库里的题名写法五花八门（组诗带序号、词带首句、曲带宫调、个别有异名），
	// 对不上的条目 -canon 会列出来供人工修 canon.go 里的别名或题名。
	canonRep := assignCanon(all)
	if *showCanon {
		canonRep.log(*canonAmb)
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatal(err)
	}

	// 逐档取题。清单档位之间故意重叠（初中也考小学背过的诗），
	// 只有走难度带的档位需要避开彼此。
	for _, lv := range levels {
		built := selectLevel(all, lv, profiles)
		path := filepath.Join(*outDir, lv.Key+".json")
		f, err := os.Create(path)
		if err != nil {
			log.Fatal(err)
		}
		enc := json.NewEncoder(f)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(built); err != nil {
			log.Fatal(err)
		}
		_ = f.Close()
		fmt.Printf("%-4s 难度分 %.3f–%.3f 合格 %7d 首，入库 %5d 首（题材标注 %d 首，带字号作者 %d 位）\n",
			lv.Label, built.ScoreLo, built.ScoreHi, built.Eligible, built.Shipped,
			countTheme(built), len(built.Authors))
		if *residue {
			printResidue(lv.Label, built.Poems)
		}
		if *probe > 0 {
			// 抽样打印供人工核对：这一档到底是不是该难度读者认识的诗
			fmt.Printf("—— %s 档抽样 ——\n", lv.Label)
			for i, p := range built.Poems {
				if i >= *probe {
					break
				}
				tag := "扩池"
				if p.Canon > 0 {
					tag = "必背"
				}
				fmt.Printf("  %s《%s》 [%s] 题材=%s 句=%d 难度=%.3f\n",
					p.Auth, p.Title, tag, orNone(p.Theme), len(p.Lines), p.Score)
			}
		}
	}

	// 字频表随题库一起发布，前端据此判断"飞花令"用字是否过僻。
	freq := make(map[string]int, len(df))
	for r, n := range df {
		freq[string(r)] = n
	}
	b, err := json.Marshal(freq)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(*outDir, "charfreq.json"), b, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("字频表 %d 条已写出", len(freq))
}

// bandIdx 把分位数换算成已按难度升序排列的数组下标。
func bandIdx(ranked []*poem, q float64) int {
	i := int(q * float64(len(ranked)-1))
	if i < 0 {
		return 0
	}
	if i >= len(ranked) {
		return len(ranked) - 1
	}
	return i
}

func bandRange(ranked []*poem, lv levelCfg) (float64, float64) {
	if lv.Full {
		return ranked[0].score, ranked[len(ranked)-1].score
	}
	return ranked[bandIdx(ranked, lv.BandLo)].score, ranked[bandIdx(ranked, lv.BandHi)].score
}

func selectLevel(ranked []*poem, lv levelCfg, profiles map[string]outAuthor) *outLevel {
	out := &outLevel{Key: lv.Key, Label: lv.Label}
	lo, hi := bandRange(ranked, lv)
	out.ScoreLo, out.ScoreHi = round4(lo), round4(hi)

	var cand []*poem
	switch {
	case lv.Canon > 0:
		cand = canonCand(ranked, lv)
	case lv.Full:
		cand = ranked
	default:
		for _, p := range ranked[bandIdx(ranked, lv.BandLo) : bandIdx(ranked, lv.BandHi)+1] {
			if eligible(p, lv) {
				cand = append(cand, p)
			}
		}
		// 分位带内的合格诗不够一档用量时扩到全库，宁可放宽分带也不能让档位开天窗
		if len(cand) < lv.Target {
			inBand := make(map[int64]bool, len(cand))
			for _, p := range cand {
				inBand[p.ID] = true
			}
			for _, p := range ranked {
				if !inBand[p.ID] && eligible(p, lv) {
					cand = append(cand, p)
				}
			}
		}
	}
	out.Eligible = len(cand)

	picked := cand
	if !lv.canonical() {
		picked = pick(cand, lv)
	}
	out.Shipped = len(picked)
	out.Poems = make([]outPoem, 0, len(picked))
	auSeen := map[string]bool{}
	for _, p := range picked {
		out.Poems = append(out.Poems, outPoem{
			ID: p.ID, Title: displayTitle(p.Title), Lines: p.clauses, Auth: p.Auth, Dyn: p.Dyn, Type: p.Type,
			Theme: p.theme, Seas: p.season, Term: string(p.term), Grp: encodeGroups(p.grp),
			Score: round4(p.score), Fame: round4(p.fameP), Canon: p.canonTier,
		})
		k := authorKey(p.Auth, p.Dyn)
		if auSeen[k] {
			continue
		}
		auSeen[k] = true
		// 字、号是小传里能稳定抽出的结构化信息，抽到才发布，供「作者之字」题型与干扰项使用
		if a, ok := profiles[k]; ok && (a.Zi != "" || a.Hao != "") {
			out.Authors = append(out.Authors, a)
		}
	}
	return out
}

// canonCand 组装清单档位的候选池：必背清单本身打头，量不够时从同一批作者
// 的其余作品里补，补进来的仍然要过该档的形式门槛（行数、齐整度、体裁）。
//
// 清单诗本身不过这些门槛——课本里有十六句的《春江花月夜》，卡行数只会把它
// 从高一下移到初三，那不对；只用一个宽松的上限把它挡在小学档外面。
func canonCand(ranked []*poem, lv levelCfg) []*poem {
	var out []*poem
	taken := map[int64]bool{}
	dups := newVarIndex()
	// 必背位先去重再入库。同一首诗在语料里常有两个抄本（李白《将进酒》在鼓吹曲辞
	// 与歌诗里各录一次、王维《使至塞上》另附「又一体」），都收进必背位会让解析里
	// 出现两条题名相同、正文略异的「标准答案」。题名短的更像课本引法，先收。
	canon := canonPool(ranked, lv.Canon)
	sort.SliceStable(canon, func(i, j int) bool { return lessCopy(canon[i], canon[j]) })
	for _, p := range canon {
		if lv.CanonMaxLines > 0 && len(p.clauses) > lv.CanonMaxLines || dups.has(p) {
			continue
		}
		taken[p.ID] = true
		dups.add(p)
		out = append(out, p)
	}
	sortCand(out)
	if len(out) >= lv.Target {
		return out
	}
	aus := canonAuthors(ranked, lv.Canon)
	var ext []*poem
	for _, p := range ranked {
		if taken[p.ID] || !aus[p.Auth] || p.canonTier > 0 || p.minDF < lv.MinCharDF ||
			!eligible(p, lv) || dups.has(p) {
			continue
		}
		ext = append(ext, p)
	}
	sort.SliceStable(ext, func(i, j int) bool {
		if ext[i].fameP != ext[j].fameP {
			return ext[i].fameP > ext[j].fameP
		}
		return ext[i].score < ext[j].score
	})
	// 扩池内部同样互相去重：两个抄本都补进来，档位里就会出现标题一样、
	// 正文差一个字的诗，出题时互为干扰项又没有可解释的差别。
	uniq := make([]*poem, 0, len(ext))
	for _, p := range ext {
		if dups.has(p) {
			continue
		}
		dups.add(p)
		uniq = append(uniq, p)
	}
	out = append(out, capByAuthor(uniq, lv.Target-len(out), lv.MaxPerAu)...)
	sortCand(out)
	return out
}

func sortCand(out []*poem) {
	sort.Slice(out, func(i, j int) bool {
		if (out[i].canonTier > 0) != (out[j].canonTier > 0) {
			return out[i].canonTier > 0
		}
		return out[i].score < out[j].score
	})
}

// varIndex 记下已入库诗的正文，用于识别同一首诗的两个抄本。
//
// 两条线索并行：
//   - 按作者比全文，抓「只差几个字」的异文（杜牧《秋夕》的银烛/红烛）；
//     题名不同也能抓到，因为异文抄本常被另编一个题名。
//   - 按「作者 + 剥掉乐府类目后的本题」比，抓同题的抄残本与「又一体」：
//     白居易《忆江南》五句全本之外还有只存前两句的本子，
//     王维《使至塞上》的又一体把首句换成「衔命辞天阙」、其余七句照抄，
//     这两种都离着两个字以上，全文比对抓不住。
//
// 不能按正文跨作者去重：王之涣《登鹳雀楼》在《全唐诗》里同时挂在朱斌《登楼》名下，
// 正文一字不差，去掉后者反而让必背清单点不到名。
type varIndex struct {
	byAu map[string][]verse
	byTi map[string][]string
}

type verse struct {
	n int
	s string
}

func newVarIndex() varIndex {
	return varIndex{byAu: map[string][]verse{}, byTi: map[string][]string{}}
}

func tiKey(p *poem) string { return p.Auth + "\x00" + luofuKey(p.Title) }

func (vi varIndex) add(p *poem) {
	joined := strings.Join(p.clauses, "")
	vi.byAu[p.Auth] = append(vi.byAu[p.Auth], verse{n: len(p.clauses), s: joined})
	vi.byTi[tiKey(p)] = append(vi.byTi[tiKey(p)], joined)
}

func (vi varIndex) has(p *poem) bool {
	joined := strings.Join(p.clauses, "")
	n := len(p.clauses)
	for _, v := range vi.byAu[p.Auth] {
		if v.n == n && closeDup(v.s, joined) {
			return true
		}
	}
	for _, s := range vi.byTi[tiKey(p)] {
		if s == joined || strings.HasPrefix(s, joined) || strings.HasPrefix(joined, s) ||
			shareMajority(p.clauses, s) {
			return true
		}
	}
	return false
}

// shareMajority 判断候选诗的句是否有三分之二原样出现在同一本题的另一首诗里。
func shareMajority(clauses []string, other string) bool {
	shared := 0
	for _, c := range clauses {
		if strings.Contains(other, c) {
			shared++
		}
	}
	n := len(clauses)
	return shared >= 2 && shared*3 >= n*2
}

// closeDup 编辑距离不超过 2 就当作同一首诗的两个抄本。
func closeDup(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	if len(ra) > len(rb) {
		ra, rb = rb, ra
	}
	if len(rb)-len(ra) > 2 {
		return false
	}
	return editLE(ra, rb, 2)
}

// editLE 判断两串的编辑距离是否 ≤ max，超过就提前退出。
func editLE(a, b []rune, max int) bool {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		rowMin := cur[0]
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			d := prev[j] + 1
			if v := cur[j-1] + 1; v < d {
				d = v
			}
			if v := prev[j-1] + cost; v < d {
				d = v
			}
			cur[j] = d
			if d < rowMin {
				rowMin = d
			}
		}
		if rowMin > max {
			return false
		}
		prev, cur = cur, prev
	}
	return prev[len(b)] <= max
}

func (lv levelCfg) canonical() bool { return lv.Canon > 0 }

// encodeGroups 把段号压成 base36 字符串，与句子数组等长。
// 超过 35 段的长诗把段号并到 35：这只影响「不跨节」判断的粒度，
// 合并尾部若干段不会让本该禁止的跨节题面变成允许。
func encodeGroups(grp []int) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, len(grp))
	for i, g := range grp {
		if g > 35 {
			g = 35
		}
		b[i] = digits[g]
	}
	return string(b)
}

// pick 决定候选池内具体取哪些诗，只服务清单之外的档位（大学、全量）。
//
// 按作者轮转取题、每人最多 MaxPerAu 首，是因为语料里宋诗占八成，
// 陆游一人传世近三万首：直接按难度分升序取前 N 首，整档会被陆游占满。
// 全量档则随机抽样，保留全库的真实构成。
func pick(cand []*poem, lv levelCfg) []*poem {
	if len(cand) <= lv.Target {
		return cand
	}
	if lv.Full {
		rng := rand.New(rand.NewSource(20261019))
		shuffled := make([]*poem, len(cand))
		copy(shuffled, cand)
		rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
		return capByAuthor(shuffled, lv.Target, lv.MaxPerAu)
	}

	groups := map[string][]*poem{}
	var authors []string
	for _, p := range cand { // cand 已按难度升序，组内顺序即由易到难
		if lv.TopAu > 0 && !isPersonal(p.Auth) {
			continue // 合集名不是诗人，不参与按作者轮转取名
		}
		if _, ok := groups[p.Auth]; !ok {
			authors = append(authors, p.Auth)
		}
		groups[p.Auth] = append(groups[p.Auth], p)
	}
	// 知名度高的作者排在前面，第一顺位就拿到该档最浅易的诗篇
	sort.Slice(authors, func(i, j int) bool {
		a, b := groups[authors[i]][0], groups[authors[j]][0]
		if a.fame != b.fame {
			return a.fame > b.fame
		}
		return a.score < b.score
	})
	// 只从知名度前 N 的作者里取题。少了这道门槛，「小学」档会变成
	// 带内上千个作者各出一首——题面全是宋人小作，而不是课本名篇。
	if lv.TopAu > 0 && len(authors) > lv.TopAu {
		authors = authors[:lv.TopAu]
	}

	var out []*poem
	seen := map[int64]bool{}
	for r := 0; len(out) < lv.Target; r++ {
		fresh := false
		for _, a := range authors {
			g := groups[a]
			if r >= len(g) || r >= lv.MaxPerAu {
				continue
			}
			if seen[g[r].ID] {
				continue
			}
			seen[g[r].ID] = true
			out = append(out, g[r])
			fresh = true
			if len(out) >= lv.Target {
				break
			}
		}
		if !fresh {
			break // 所有作者都取满了上限
		}
	}
	// 轮转取不满目标量时（作者数 × 上限 < Target），沿难度带继续补齐，
	// 但必须跳过已入库的同一首，否则重复条目会让题目的正确选项出现两次。
	if len(out) < lv.Target {
		for _, p := range cand {
			if len(out) >= lv.Target {
				break
			}
			if seen[p.ID] {
				continue
			}
			seen[p.ID] = true
			out = append(out, p)
		}
	}
	// 最终按难度升序落盘，便于前端展示难度跨度
	sort.Slice(out, func(i, j int) bool { return out[i].score < out[j].score })
	return out
}

func capByAuthor(list []*poem, n, cap int) []*poem {
	per := map[string]int{}
	out := make([]*poem, 0, n)
	for _, p := range list {
		if len(out) >= n {
			break
		}
		if cap > 0 && per[p.Auth] >= cap {
			continue
		}
		per[p.Auth]++
		out = append(out, p)
	}
	return out
}

func eligible(p *poem, lv levelCfg) bool {
	if lv.MaxLines > 0 && len(p.clauses) > lv.MaxLines {
		return false
	}
	if !lv.AllowNote && hasNote(p) {
		return false
	}
	if lv.MaxTypeW > 0 && p.typeW > lv.MaxTypeW {
		return false
	}
	// 小学档要求句式齐整：平均句长落在五七言区间
	if lv.NeatLines && (p.avgLen < 4 || p.avgLen > 9) {
		return false
	}
	return true
}

func hasNote(p *poem) bool {
	for _, c := range p.clauses {
		if strings.ContainsAny(c, "[]") {
			return true
		}
	}
	return false
}

func isHan(r rune) bool {
	return unicode.Is(unicode.Han, r)
}

// isPersonal 区分「具体诗人」与「作品合集名」。后者收录量大，
// 不能按作者产量参与知名度排序。
func isPersonal(name string) bool {
	if name == "" {
		return false
	}
	for _, bad := range []string{"无名氏", "佚名", "不详", "歌辞", "郊庙", "唐无名", "宋无名"} {
		if strings.Contains(name, bad) {
			return false
		}
	}
	return len([]rune(name)) <= 8
}

const placeholder = '□' // 整理本里的脱文占位符

// usable 过滤不适合出题的条目：含脱文方框、残句、超长题名。
func usable(title string, clauses []string) bool {
	if strings.ContainsRune(title, placeholder) || title == "句" ||
		strings.HasPrefix(title, "句 ") || len([]rune(title)) > 34 {
		return false
	}
	for _, c := range clauses {
		if strings.ContainsRune(c, placeholder) {
			return false
		}
	}
	return true
}

// cleanTitle 压缩空白，并去掉「菩萨蛮·菩萨蛮 其一」这类重复的词牌前缀。
//
// 必须按整个「·」处理：它是两字节的 U+00B7，早先用 strings.Index 的字节下标
// 加 1 去切，正好切进字符中间，折叠判断失效，标题又被下面的「多重副题」规则
// 判成脏数据清空——李煜《虞美人·虞美人·春花秋月何时了》整批词因此从题库里消失。
func cleanTitle(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	parts := strings.Split(s, "·")
	if len(parts) >= 3 && parts[0] == parts[1] {
		parts = append([]string{parts[0]}, parts[2:]...)
		s = strings.Join(parts, "·")
	}
	return s
}

func round4(f float64) float64 { return math.Round(f*10000) / 10000 }

func countTheme(lv *outLevel) int {
	n := 0
	for _, p := range lv.Poems {
		if p.Theme != "" {
			n++
		}
	}
	return n
}

func orNone(s string) string {
	if s == "" {
		return "未判定"
	}
	return s
}

func authorKey(name, dyn string) string { return name + "\x00" + dyn }

// humanCount 把 log10 的结果数量级还原成人能读的字符串，只用于日志。
func humanCount(logv float64) string {
	v := math.Pow(10, logv)
	switch {
	case v >= 1e8:
		return fmt.Sprintf("%.1f 亿", v/1e8)
	case v >= 1e4:
		return fmt.Sprintf("%.0f 万", v/1e4)
	default:
		return fmt.Sprintf("%.0f", v)
	}
}
