package main

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// 必背清单。
//
// rank/ 的搜索量当「知名度」用是失败的：它奖励的是泛化题名，
// 范成大《江上》、陆游《雪》这类无人读过的宋人小作照样排到分位 0.99。
// 「小学档要简单」这件事没有客观代理指标可依赖——它其实是
// 「读者课本里背过」，只能人工列清单。清单在这里是唯一的真来源，
// 生成时按「作者 + 容错题名」和库里的条目对上，对不上的会在日志里报出来。
//
// 库里的题名写法和课本不一样，不能要求全等：
//   - 组诗带序号：回乡偶书 → 「回乡偶书二首 一」
//   - 词带首句：水调歌头 → 「水调歌头·明月几时有」
//   - 曲带宫调：天净沙 → 「越调・天净沙秋思」
//   - 个别有异名：琵琶行 → 「琵琶引」
// 所以匹配规则是「全等 / 前缀 / 短题名包含」三档，再加一张异名表。

type canonRef struct{ au, ti string }

func cr(au, ti string) canonRef { return canonRef{au, ti} }

// canonPrimary 小学（含一、二年级与中高年级的古诗必背篇目）。
var canonPrimary = []canonRef{
	cr("骆宾王", "咏鹅"), cr("李峤", "风"), cr("贺知章", "咏柳"), cr("贺知章", "回乡偶书"),
	cr("王之涣", "登鹳雀楼"), cr("王之涣", "凉州词"), cr("孟浩然", "春晓"), cr("李白", "静夜思"),
	cr("李白", "古朗月行"), cr("李白", "望庐山瀑布"), cr("李白", "赠汪伦"), cr("李白", "早发白帝城"),
	cr("李白", "望天门山"), cr("李白", "独坐敬亭山"), cr("李白", "黄鹤楼送孟浩然之广陵"),
	cr("杜甫", "绝句"), cr("杜甫", "江畔独步寻花"), cr("杜甫", "春夜喜雨"),
	cr("杜甫", "闻官军收河南河北"), cr("杜甫", "江南逢李龟年"),
	cr("白居易", "赋得古原草送别"), cr("白居易", "池上"), cr("白居易", "忆江南"), cr("白居易", "暮江吟"),
	cr("李绅", "悯农"), cr("张继", "枫桥夜泊"), cr("韦应物", "滁州西涧"), cr("张志和", "渔歌子"),
	cr("卢纶", "塞下曲"), cr("韩翃", "寒食"), cr("戎昱", "塞上曲"), cr("高适", "别董大"),
	cr("岑参", "逢入京使"), cr("刘禹锡", "望洞庭"), cr("刘禹锡", "浪淘沙"), cr("柳宗元", "江雪"),
	cr("元稹", "行宫"), cr("贾岛", "寻隐者不遇"), cr("杜牧", "山行"), cr("杜牧", "清明"),
	cr("杜牧", "秋夕"), cr("杜牧", "赤壁"), cr("杜牧", "泊秦淮"), cr("温庭筠", "望江南"),
	cr("李商隐", "夜雨寄北"), cr("李商隐", "乐游原"), cr("虞世南", "蝉"), cr("宋之问", "渡汉江"),
	cr("王维", "鹿柴"), cr("王维", "相思"), cr("王维", "送元二使安西"), cr("王维", "九月九日忆山东兄弟"),
	cr("王维", "竹里馆"), cr("王维", "鸟鸣涧"), cr("王昌龄", "出塞"), cr("王昌龄", "从军行"),
	cr("王昌龄", "芙蓉楼送辛渐"), cr("孟郊", "游子吟"), cr("李贺", "马诗"), cr("罗隐", "蜂"),
	cr("胡令能", "小儿垂钓"), cr("杨万里", "小池"), cr("杨万里", "晓出净慈寺送林子方"),
	cr("杨万里", "宿新市徐公店"), cr("杨万里", "舟过安仁"), cr("杨万里", "闲居初夏午睡起"),
	cr("苏轼", "题西林壁"), cr("苏轼", "饮湖上初晴后雨"), cr("苏轼", "惠崇春江晚景"),
	cr("王安石", "元日"), cr("王安石", "泊船瓜洲"), cr("王安石", "书湖阴先生壁"), cr("王安石", "梅花"),
	cr("王安石", "登飞来峰"), cr("曾几", "三衢道中"), cr("范成大", "四时田园杂兴"),
	cr("朱熹", "春日"), cr("朱熹", "观书有感"), cr("李清照", "夏日绝句"), cr("陆游", "示儿"),
	cr("陆游", "秋夜将晓出篱门迎凉有感"), cr("陆游", "冬夜读书示子聿"), cr("陆游", "游山西村"),
	cr("林升", "题临安邸"), cr("叶绍翁", "游园不值"), cr("叶绍翁", "夜书所见"), cr("翁卷", "乡村四月"),
	cr("张若虚", "春江花月夜"), cr("陈子昂", "登幽州台歌"),
	// 陶渊明、北朝民歌（敕勒歌）、汉乐府（长歌行）在本语料里没有条目：
	// chinese-poetry 以全唐诗 / 全宋诗 / 宋词 / 元曲为主，先秦汉魏六朝几乎不收。
}

// canonJunior 初中必背。
var canonJunior = []canonRef{
	cr("曹操", "观沧海"), cr("曹操", "龟虽寿"),
	cr("王勃", "送杜少府之任蜀州"), cr("张九龄", "望月怀远"),
	cr("常建", "题破山寺后禅院"), cr("王维", "使至塞上"), cr("王维", "山居秋暝"),
	cr("李白", "行路难"), cr("李白", "闻王昌龄左迁龙标遥有此寄"), cr("李白", "渡荆门送别"),
	cr("李白", "送友人"), cr("李白", "宣州谢朓楼饯别校书叔云"), cr("李白", "秋浦歌"),
	cr("杜甫", "望岳"), cr("杜甫", "春望"), cr("杜甫", "石壕吏"), cr("杜甫", "茅屋为秋风所破歌"),
	cr("岑参", "白雪歌送武判官归京"),
	cr("刘禹锡", "酬乐天扬州初逢席上见赠"), cr("刘禹锡", "秋词"), cr("白居易", "卖炭翁"),
	cr("白居易", "钱塘湖春行"), cr("白居易", "观刈麦"), cr("柳宗元", "渔翁"),
	cr("温庭筠", "商山早行"), cr("李商隐", "无题"), cr("李商隐", "夜雨寄北"),
	cr("晏殊", "浣溪沙"), cr("苏轼", "水调歌头"), cr("苏轼", "江城子"), cr("苏轼", "卜算子"),
	cr("苏轼", "定风波"), cr("李清照", "如梦令"),
	cr("李清照", "醉花阴"), cr("李清照", "声声慢"), cr("李清照", "渔家傲"),
	cr("陆游", "诉衷情"), cr("陆游", "十一月四日风雨大作"), cr("杨万里", "过松源晨炊漆公店"),
	cr("辛弃疾", "南乡子"), cr("辛弃疾", "破阵子"), cr("辛弃疾", "永遇乐"), cr("辛弃疾", "西江月"),
	cr("辛弃疾", "青玉案"), cr("文天祥", "过零丁洋"), cr("范仲淹", "渔家傲"), cr("范仲淹", "苏幕遮"),
	cr("秦观", "踏莎行"), cr("马致远", "天净沙"), cr("纳兰性德", "长相思"),
	cr("高适", "封丘作"), cr("杜牧", "过华清宫"),
	cr("罗隐", "雪"), cr("皮日休", "橡媪叹"),
}

// canonSenior 高中必背。
var canonSenior = []canonRef{
	cr("屈原", "涉江"), cr("屈原", "国殇"), cr("曹操", "短歌行"), cr("曹操", "苦寒行"),
	// 陶渊明、鲍照、谢朓、李璟这批先唐作者本语料不收，元好问《论诗》、王实甫《西厢记》同样缺条目。
	cr("王维", "辋川闲居赠裴秀才迪"), cr("李白", "蜀道难"),
	cr("李白", "梦游天姥吟留别"), cr("李白", "将进酒"), cr("杜甫", "登高"),
	cr("杜甫", "登岳阳楼"), cr("杜甫", "兵车行"), cr("杜甫", "咏怀古迹"), cr("杜甫", "秋兴"),
	cr("杜甫", "蜀相"), cr("杜甫", "客至"), cr("杜甫", "旅夜书怀"), cr("杜甫", "阁夜"),
	cr("杜甫", "江南逢李龟年"), cr("白居易", "琵琶行"), cr("白居易", "长恨歌"),
	cr("李商隐", "锦瑟"), cr("李商隐", "马嵬"),
	cr("李贺", "雁门太守行"), cr("李贺", "李凭箜篌引"), cr("温庭筠", "菩萨蛮"),
	cr("韦庄", "菩萨蛮"), cr("李煜", "虞美人"), cr("李煜", "浪淘沙"), cr("李煜", "相见欢"),
	cr("柳永", "望海潮"), cr("柳永", "雨霖铃"), cr("柳永", "八声甘州"),
	cr("王安石", "桂枝香"), cr("王安石", "登飞来峰"), cr("苏轼", "念奴娇"), cr("苏轼", "定风波"),
	cr("苏轼", "临江仙"), cr("苏轼", "卜算子"), cr("黄庭坚", "登快阁"), cr("秦观", "鹊桥仙"),
	cr("周邦彦", "苏幕遮"), cr("陆游", "书愤"), cr("陆游", "临安春雨初霁"),
	cr("辛弃疾", "摸鱼儿"), cr("辛弃疾", "永遇乐"), cr("李清照", "永遇乐"),
	cr("姜夔", "扬州慢"), cr("关汉卿", "窦娥冤"), cr("纳兰性德", "木兰词"),
}

// canonAlias 课本题名与库里题名的异名，仅列包含规则也套不住的。
// 琵琶行在库中题作「琵琶引」，其余异名跑一遍 -canon 再往这里补。
var canonAlias = map[string]string{
	"琵琶行":       "琵琶引",
	"渔歌子":       "渔父歌",
	"送杜少府之任蜀州":  "杜少府之任蜀州",
	"木兰词":       "木兰花令",
	"望江南":       "梦江南",
	"钱塘湖春行":     "钱唐湖春行",
	"晓出净慈寺送林子方": "晓出净慈送林子方",
}

// canonTier 的档位序号，与 levels[].Canon 对应。
const (
	tierPrimary = 1
	tierJunior  = 2
	tierSenior  = 3
)

func normKey(s string) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsSpace(r) {
			continue
		}
		if strings.ContainsRune("（）()·・　，、：？！「」《》", r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// canonMatch 判断库里题名 ti 是否是课本题名 want 的同一个篇目。
//
// 库里的题名常带前缀或后缀（宫调「越调・天净沙秋思」、组诗序号「…六十首 其一」、
// 杂题副名「皇甫岳云溪杂题五首 鸟鸣涧」、词牌叠写「虞美人·虞美人·春花秋月」）。
// 因为调用方已经先用作者把候选缩到一个人的名下，题名只要「包含」课本篇目就足够定位，
// 不会跨作者误伤。三字以下（风、蝉、江雪）才要求以课本题名起头，避免「风」命中一堆。
func canonMatch(want, ti string) bool {
	w, t := normKey(want), normKey(ti)
	if w == "" || t == "" {
		return false
	}
	if w == t {
		return true
	}
	if len([]rune(w)) <= 2 {
		return strings.HasPrefix(t, w)
	}
	return strings.Contains(t, w)
}

type canonReport struct {
	Matched map[int][]string
	Missed  map[int][]string
}

// assignCanon 给每首诗标注它属于哪个课本档位的必背篇目，返回核对报告。
//
// 一个条目可能对上多首（组诗「悯农二首」，或同题《绝句》两首），
// 全部收下：它们本就是同一课内容。取上限防止《无题》这类同题扎堆。
func assignCanon(all []*poem) canonReport {
	byAuthor := map[string][]*poem{}
	for _, p := range all {
		k := normKey(p.Auth)
		byAuthor[k] = append(byAuthor[k], p)
	}

	rep := canonReport{Matched: map[int][]string{}, Missed: map[int][]string{}}
	for tier, list := range map[int][]canonRef{tierPrimary: canonPrimary, tierJunior: canonJunior, tierSenior: canonSenior} {
		for _, ref := range list {
			var hits []*poem
			for _, p := range byAuthor[normKey(ref.au)] {
				if canonMatch(ref.ti, p.Title) || canonMatch(canonAlias[ref.ti], p.Title) {
					hits = append(hits, p)
				}
			}
			if len(hits) == 0 {
				// 报出作者桶里到底有哪些题名：区分「作者名下无诗」与「有诗但题形不对」
				bucket := byAuthor[normKey(ref.au)]
				pre := head([]rune(ref.ti), 2)
				var titles []string
				for _, p := range bucket {
					if strings.Contains(p.Title, string(pre)) {
						titles = append(titles, p.Title)
					}
				}
				if len(titles) == 0 {
					titles = []string{fmt.Sprintf("(作者桶共 %d 首)", len(bucket))}
				}
				rep.Missed[tier] = append(rep.Missed[tier],
					fmt.Sprintf("%s《%s》 近题=%v", ref.au, ref.ti, head(titles, 4)))
				continue
			}
			// 命中多首时优先短题名、再按浅易程度，只留最像课本那一首的几首
			sort.SliceStable(hits, func(i, j int) bool {
				li, lj := len([]rune(hits[i].Title)), len([]rune(hits[j].Title))
				if li != lj {
					return li < lj
				}
				return hits[i].score < hits[j].score
			})
			if len(hits) > 3 {
				hits = hits[:3]
			}
			for _, p := range hits {
				if p.canonTier == 0 || tier < p.canonTier {
					p.canonTier = tier
				}
				rep.Matched[tier] = append(rep.Matched[tier], fmt.Sprintf("%s《%s》", p.Auth, p.Title))
			}
		}
	}
	return rep
}

// canonPool 取 tier 及其以下各档的全部必背诗——初中档当然可以考小学背过的诗，
// 档位之间的区别是「新增难度」，不是「旧的不许出现」。
func canonPool(all []*poem, tier int) []*poem {
	var out []*poem
	for _, p := range all {
		if p.canonTier > 0 && p.canonTier <= tier {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].canonTier != out[j].canonTier {
			return out[i].canonTier > out[j].canonTier
		}
		return out[i].score < out[j].score
	})
	return out
}

// canonAuthors 该档位必背清单里出现过的作者。扩池只从这些人的其余作品里取，
// 这样补量的诗仍然大概率是读者听过的名字。
func canonAuthors(all []*poem, tier int) map[string]bool {
	set := map[string]bool{}
	for _, p := range all {
		if p.canonTier > 0 && p.canonTier <= tier {
			set[p.Auth] = true
		}
	}
	return set
}

func (r canonReport) log() {
	labels := map[int]string{tierPrimary: "小学", tierJunior: "初中", tierSenior: "高中"}
	for _, tier := range []int{tierPrimary, tierJunior, tierSenior} {
		total := []int{len(canonPrimary), len(canonJunior), len(canonSenior)}[tier-1]
		fmt.Printf("必背清单 %s：%d 条里 %d 条对上了，命中诗 %d 首\n",
			labels[tier], total, total-len(r.Missed[tier]), len(r.Matched[tier]))
		for _, s := range r.Missed[tier] {
			fmt.Printf("   缺 %s\n", s)
		}
	}
}

func head[T any](s []T, n int) []T {
	if len(s) < n {
		return s
	}
	return s[:n]
}
