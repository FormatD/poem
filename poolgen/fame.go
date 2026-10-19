package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/liuzl/gocc"
)

// rankEntry 是 chinese-poetry 的 rank/ 目录里一条搜索结果计数。
// 该目录按「作者+题名」统计了百度、360、必应（中/国际版）、谷歌的结果数，
// 结果越多通常说明这首诗词越为人熟知。这是语料之外唯一的客观知名度信号，
// 单靠字频和体裁没法把「静夜思」从同字同体的上千首宋人绝句里挑出来。
type rankEntry struct {
	Baidu  int    `json:"baidu"`
	So360  int    `json:"so360"`
	Bing   int    `json:"bing"`
	BingEn int    `json:"bing_en"`
	Google int    `json:"google"`
	Author string `json:"author"`
	Title  string `json:"title"`
}

func fameKey(author, title string) string { return author + "\x00" + title }

// loadFame 返回 简体「作者\0题名」→ log10(搜索引擎结果量中位数)。
//
// rank 数据与源语料同为繁体，而本应用读的是简体表，所以先把键转成简体。
// 简体表正是同一批源文本经 t2s 生成的，两边转换一致才配得上；
// 转换有差异时只会漏配（知名度按 0 处理），不会配错到别的诗上。
func loadFame(rankDir string) (map[string]float64, error) {
	t2s, err := gocc.New("t2s")
	if err != nil {
		return nil, fmt.Errorf("init t2s: %w", err)
	}

	var files []string
	for _, sub := range []string{"poet", "ci"} {
		g, err := filepath.Glob(filepath.Join(rankDir, sub, "*.json"))
		if err != nil {
			return nil, err
		}
		if len(g) == 0 {
			return nil, fmt.Errorf("知名度数据缺失：%s 下没有 json 文件", filepath.Join(rankDir, sub))
		}
		files = append(files, g...)
	}

	out := make(map[string]float64, 300000)
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		var entries []rankEntry
		if err := json.Unmarshal(b, &entries); err != nil {
			log.Printf("跳过 %s: %v", filepath.Base(f), err)
			continue
		}
		for _, e := range entries {
			if e.Author == "" || e.Title == "" {
				continue
			}
			med := median(e.Baidu, e.So360, e.Bing, e.BingEn, e.Google)
			if med <= 0 {
				continue
			}
			// 辑佚残句在搜索引擎里能匹配到海量「这句出自哪首」的页面，
			// 题名本身就是「句」的记录全是噪声
			if cleanRankTitle(e.Title) == "" {
				continue
			}
			a, err := t2s.Convert(e.Author)
			if err != nil {
				return nil, err
			}
			t, err := t2s.Convert(e.Title)
			if err != nil {
				return nil, err
			}
			k := fameKey(a, t)
			v := math.Log10(float64(med) + 1)
			if v > out[k] {
				out[k] = v
			}
		}
	}
	return out, nil
}

// cleanRankTitle 判断题名是否是有独立意义的作品名（而非「句」这类辑佚标记）。
func cleanRankTitle(s string) string {
	switch s {
	case "句", "断句", "残句", "联", "对":
		return ""
	}
	return s
}

func median(vals ...int) int {
	s := append([]int(nil), vals...)
	sort.Ints(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// printResidue 数一数字库里还残留多少非简体字：把每个不重复的字单独过一遍 t2s，
// 转换后变形的就是漏网字（繁体如「隠」、日本新字体如「聴」「壊」）。
// 分简体表都是直接从繁体源转的，转换表覆盖不到的字就原样留下来了。
func printResidue(label string, ps []outPoem) {
	t2s, err := gocc.New("t2s")
	if err != nil {
		log.Printf("残字统计失败：%v", err)
		return
	}
	cache := map[rune]bool{}
	residue := map[rune]int{}
	isResidue := func(r rune) bool {
		if v, ok := cache[r]; ok {
			return v
		}
		s, err := t2s.Convert(string(r))
		v := err == nil && s != string(r)
		cache[r] = v
		return v
	}

	poemHit, clauseHit, clauseAll := 0, 0, 0
	canonHit := []string{}
	for _, p := range ps {
		bad := false
		for _, line := range p.Lines {
			clauseAll++
			n := 0
			for _, r := range line {
				if isHan(r) && isResidue(r) {
					n++
					residue[r]++
				}
			}
			if n > 0 {
				clauseHit++
				bad = true
			}
		}
		if bad {
			poemHit++
			if p.Canon > 0 && len(canonHit) < 3 {
				canonHit = append(canonHit, fmt.Sprintf("%s《%s》", p.Auth, p.Title))
			}
		}
	}

	type kv struct {
		r rune
		n int
	}
	var ranked []kv
	for r, n := range residue {
		ranked = append(ranked, kv{r, n})
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].n > ranked[j].n })
	var top []string
	for i, e := range ranked {
		if i >= 8 {
			break
		}
		top = append(top, fmt.Sprintf("%s×%d", string(e.r), e.n))
	}

	fmt.Printf("     %-4s 含残字 %d/%d 首、%d/%d 句（%.2f%% 句）｜常见残字 %s\n",
		label, poemHit, len(ps), clauseHit, clauseAll,
		100*float64(clauseHit)/math.Max(float64(clauseAll), 1), strings.Join(top, " "))
	if len(canonHit) > 0 {
		fmt.Printf("          必背篇目受影响：%s\n", strings.Join(canonHit, "、"))
	}
}
