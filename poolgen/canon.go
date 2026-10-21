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

type canonRef struct {
	au, ti string
	fl     string // 首句锚点，空表示题名已经唯一
}

func cr(au, ti string) canonRef { return canonRef{au: au, ti: ti} }

// crf 带首句锚点的条目。
//
// 只按「作者 + 题名」匹配不够用：《全唐诗》里白居易名下以「池上」起头的题有 24 个，
// 按题名长度取前三首，落进必背位的是无人读过的五律「褭褭凉风动」，
// 课本那首「小娃撑小艇」题作《池上二绝 二》，正好被截断线切在外面。
// 首句是一首诗唯一的硬标识，写进清单就不再依赖题名的运气。
func crf(au, ti, fl string) canonRef { return canonRef{au: au, ti: ti, fl: fl} }

// canonPrimary 小学（含一、二年级与中高年级的古诗必背篇目）。
//
// 锚点抄的是语料原句，不是记忆里的课本写法：《宿新市徐公店》库里作
// 「篱落疎疎一迳深」，《书湖阴先生壁》作「茆檐长扫静无苔」。
// 按课本写成「篱落疏疏一径深」「茅檐长扫净无苔」一条都对不上，
// 而锚点落空的条目会从必背位掉进扩池——比选错篇目更难发现。
// 用 -canonamb 打候选原句，照抄。
var canonPrimary = []canonRef{
	crf("骆宾王", "咏鹅", "鹅鹅鹅"), crf("李峤", "风", "解落三秋叶"), cr("贺知章", "咏柳"),
	crf("贺知章", "回乡偶书", "少小离家老大回"), crf("贺知章", "回乡偶书", "离别家乡岁月多"),
	crf("王之涣", "登鹳雀楼", "白日依山尽"), crf("王之涣", "凉州词", "黄河远上白云间"),
	cr("孟浩然", "春晓"), cr("李白", "静夜思"),
	crf("李白", "古朗月行", "小时不识月"), crf("李白", "望庐山瀑布", "日照香炉生紫烟"),
	cr("李白", "赠汪伦"), cr("李白", "早发白帝城"),
	cr("李白", "望天门山"), crf("李白", "独坐敬亭山", "众鸟高飞尽"),
	cr("李白", "黄鹤楼送孟浩然之广陵"),
	crf("杜甫", "绝句", "两个黄鹂鸣翠柳"), crf("杜甫", "绝句", "迟日江山丽"),
	crf("杜甫", "江畔独步寻花", "黄四娘家花满蹊"), crf("杜甫", "江畔独步寻花", "黄师塔前江水东"),
	cr("杜甫", "春夜喜雨"), crf("杜甫", "闻官军收河南河北", "剑外忽传收蓟北"),
	crf("杜甫", "江南逢李龟年", "岐王宅里寻常见"),
	crf("白居易", "赋得古原草送别", "离离原上草"), crf("白居易", "池上", "小娃撑小艇"),
	crf("白居易", "忆江南", "江南好"), cr("白居易", "暮江吟"),
	crf("李绅", "悯农", "锄禾日当午"), crf("李绅", "悯农", "秋收万颗子"),
	cr("张继", "枫桥夜泊"), cr("韦应物", "滁州西涧"), crf("张志和", "渔歌子", "西塞山前白鹭飞"),
	crf("卢纶", "塞下曲", "月黑雁飞高"), crf("卢纶", "塞下曲", "林暗草惊风"),
	crf("卢纶", "塞下曲", "鹫翎金仆姑"), cr("韩翃", "寒食"), cr("戎昱", "塞上曲"),
	crf("高适", "别董大", "千里黄云白日曛"), cr("岑参", "逢入京使"), cr("刘禹锡", "望洞庭"),
	crf("刘禹锡", "浪淘沙", "九曲黄河万里沙"), crf("刘禹锡", "浪淘沙", "八月涛声吼地来"),
	cr("柳宗元", "江雪"), cr("元稹", "行宫"), crf("贾岛", "寻隐者不遇", "松下问童子"),
	crf("杜牧", "山行", "远上寒山石径斜"), cr("杜牧", "清明"),
	crf("杜牧", "秋夕", "银烛秋光冷画屏"), crf("杜牧", "赤壁", "折戟沉沙铁未销"), cr("杜牧", "泊秦淮"),
	crf("温庭筠", "望江南", "梳洗罢"),
	cr("李商隐", "夜雨寄北"), crf("李商隐", "乐游原", "向晚意不适"), cr("虞世南", "蝉"),
	cr("宋之问", "渡汉江"),
	cr("王维", "鹿柴"), cr("王维", "相思"), cr("王维", "送元二使安西"),
	cr("王维", "九月九日忆山东兄弟"), cr("王维", "竹里馆"), cr("王维", "鸟鸣涧"),
	crf("王昌龄", "出塞", "秦时明月汉时关"), crf("王昌龄", "从军行", "青海长云暗雪山"),
	crf("王昌龄", "芙蓉楼送辛渐", "寒雨连江夜入吴"), cr("孟郊", "游子吟"),
	crf("李贺", "马诗", "大漠沙如雪"), cr("罗隐", "蜂"),
	cr("胡令能", "小儿垂钓"), crf("杨万里", "小池", "泉眼无声惜细流"),
	crf("杨万里", "晓出净慈寺送林子方", "毕竟西湖六月中"),
	crf("杨万里", "宿新市徐公店", "篱落疎疎一迳深"), crf("杨万里", "舟过安仁", "一叶渔船两小童"),
	crf("杨万里", "闲居初夏午睡起", "梅子留酸软齿牙"),
	crf("苏轼", "题西林壁", "横看成岭侧成峰"), crf("苏轼", "饮湖上初晴后雨", "水光潋滟晴方好"),
	crf("苏轼", "惠崇春江晚景", "竹外桃花三两枝"),
	cr("王安石", "元日"), cr("王安石", "泊船瓜洲"),
	crf("王安石", "书湖阴先生壁", "茆檐长扫静无苔"), crf("王安石", "梅花", "墙角数枝梅"),
	cr("王安石", "登飞来峰"), cr("曾几", "三衢道中"),
	crf("范成大", "四时田园杂兴", "昼出耘田夜绩麻"), crf("范成大", "四时田园杂兴", "梅子金黄杏子肥"),
	crf("朱熹", "春日", "胜日寻芳泗水滨"), crf("朱熹", "观书有感", "半亩方塘一鉴开"),
	crf("朱熹", "观书有感", "昨夜江边春水生"), crf("李清照", "夏日绝句", "生当为人杰"), // 语料作「为」，课本通行作「作」：锚点抄库里那版
	crf("陆游", "示儿", "死去元知万事空"),
	crf("陆游", "秋夜将晓出篱门迎凉有感", "三万里河东入海"),
	crf("陆游", "冬夜读书示子聿", "古人学问无遗力"), cr("陆游", "游山西村"),
	cr("林升", "题临安邸"), cr("叶绍翁", "游园不值"), cr("叶绍翁", "夜书所见"), cr("翁卷", "乡村四月"),
	crf("张若虚", "春江花月夜", "春江潮水连海平"), crf("陈子昂", "登幽州台歌", "前不见古人"),
	// 陶渊明、北朝民歌（敕勒歌）、汉乐府（长歌行）在本语料里没有条目：
	// chinese-poetry 以全唐诗 / 全宋诗 / 宋词 / 元曲为主，先秦汉魏六朝几乎不收。
}

// canonJunior 初中必背。
var canonJunior = []canonRef{
	cr("曹操", "观沧海"), cr("曹操", "龟虽寿"),
	cr("王勃", "送杜少府之任蜀州"), cr("张九龄", "望月怀远"),
	cr("常建", "题破山寺后禅院"), crf("王维", "使至塞上", "单车欲问边"), cr("王维", "山居秋暝"),
	crf("李白", "行路难", "金樽清酒斗十千"), cr("李白", "闻王昌龄左迁龙标遥有此寄"),
	cr("李白", "渡荆门送别"),
	crf("李白", "送友人", "青山横北郭"), cr("李白", "宣州谢朓楼饯别校书叔云"),
	crf("李白", "秋浦歌", "白发三千丈"),
	crf("杜甫", "望岳", "岱宗夫如何"), cr("杜甫", "春望"), cr("杜甫", "石壕吏"), cr("杜甫", "茅屋为秋风所破歌"),
	cr("岑参", "白雪歌送武判官归京"),
	cr("刘禹锡", "酬乐天扬州初逢席上见赠"),
	crf("刘禹锡", "秋词", "自古逢秋悲寂寥"), crf("刘禹锡", "秋词", "山明水净夜来霜"),
	crf("白居易", "卖炭翁", "卖炭翁"),
	cr("白居易", "钱塘湖春行"), cr("白居易", "观刈麦"), cr("柳宗元", "渔翁"),
	cr("温庭筠", "商山早行"),
	crf("李商隐", "无题", "相见时难别亦难"), crf("李商隐", "无题", "昨夜星辰昨夜风"),
	cr("李商隐", "夜雨寄北"),
	crf("晏殊", "浣溪沙", "一曲新词酒一杯"), crf("苏轼", "水调歌头", "明月几时有"),
	crf("苏轼", "江城子", "十年生死两茫茫"), crf("苏轼", "江城子", "老夫聊发少年狂"),
	crf("苏轼", "卜算子", "缺月挂疏桐"), crf("苏轼", "定风波", "莫听穿林打叶声"),
	crf("李清照", "如梦令", "常记溪亭日暮"), crf("李清照", "如梦令", "昨夜雨疏风骤"),
	cr("李清照", "醉花阴"), cr("李清照", "声声慢"), crf("李清照", "渔家傲", "天接云涛连晓雾"),
	crf("陆游", "诉衷情", "当年万里觅封侯"),
	crf("陆游", "十一月四日风雨大作", "僵卧孤村不自哀"),
	crf("陆游", "十一月四日风雨大作", "风卷江湖雨暗村"),
	crf("杨万里", "过松源晨炊漆公店", "莫言下岭便无难"),
	crf("辛弃疾", "南乡子", "何处望神州"), crf("辛弃疾", "破阵子", "醉里挑灯看剑"),
	crf("辛弃疾", "永遇乐", "千古江山"), crf("辛弃疾", "西江月", "明月别枝惊鹊"),
	cr("辛弃疾", "青玉案"), cr("文天祥", "过零丁洋"), cr("范仲淹", "渔家傲"), cr("范仲淹", "苏幕遮"),
	cr("秦观", "踏莎行"), cr("马致远", "天净沙"), crf("纳兰性德", "长相思", "山一程"),
	crf("高适", "封丘作", "我本渔樵孟诸野"), crf("杜牧", "过华清宫", "长安回望绣成堆"),
	crf("罗隐", "雪", "尽道丰年瑞"), cr("皮日休", "橡媪叹"),
}

// canonSenior 高中必背。
var canonSenior = []canonRef{
	cr("屈原", "涉江"), cr("屈原", "国殇"), crf("曹操", "短歌行", "对酒当歌"), cr("曹操", "苦寒行"),
	// 陶渊明、鲍照、谢朓、李璟这批先唐作者本语料不收，元好问《论诗》、王实甫《西厢记》同样缺条目。
	cr("王维", "辋川闲居赠裴秀才迪"), crf("李白", "蜀道难", "噫吁"),
	cr("李白", "梦游天姥吟留别"), crf("李白", "将进酒", "君不见黄河之水天上来"),
	crf("杜甫", "登高", "风急天高"),
	crf("杜甫", "登岳阳楼", "昔闻洞庭水"), cr("杜甫", "兵车行"),
	crf("杜甫", "咏怀古迹", "群山万壑赴荆门"), crf("杜甫", "秋兴", "玉露凋伤枫树林"),
	cr("杜甫", "蜀相"), cr("杜甫", "客至"), cr("杜甫", "旅夜书怀"), cr("杜甫", "阁夜"),
	crf("杜甫", "江南逢李龟年", "岐王宅里寻常见"), cr("白居易", "琵琶行"), cr("白居易", "长恨歌"),
	cr("李商隐", "锦瑟"), crf("李商隐", "马嵬", "海外徒闻更九州"),
	crf("李贺", "雁门太守行", "黑云压城城欲摧"), cr("李贺", "李凭箜篌引"),
	crf("温庭筠", "菩萨蛮", "小山重叠金明灭"),
	crf("韦庄", "菩萨蛮", "人人尽说江南好"), crf("李煜", "虞美人", "春花秋月何时了"),
	crf("李煜", "浪淘沙", "帘外雨潺潺"), crf("李煜", "相见欢", "无言独上西楼"),
	crf("李煜", "相见欢", "林花谢了春红"),
	cr("柳永", "望海潮"), cr("柳永", "雨霖铃"), cr("柳永", "八声甘州"),
	cr("王安石", "桂枝香"), cr("王安石", "登飞来峰"), crf("苏轼", "念奴娇", "大江东去"),
	crf("苏轼", "定风波", "莫听穿林打叶声"),
	crf("苏轼", "临江仙", "夜饮东坡醒复醉"), crf("苏轼", "卜算子", "缺月挂疏桐"),
	cr("黄庭坚", "登快阁"), cr("秦观", "鹊桥仙"),
	cr("周邦彦", "苏幕遮"), crf("陆游", "书愤", "早岁那知世事艰"), cr("陆游", "临安春雨初霁"),
	crf("辛弃疾", "摸鱼儿", "更能消"), crf("辛弃疾", "永遇乐", "千古江山"), cr("李清照", "永遇乐"),
	cr("姜夔", "扬州慢"), crf("关汉卿", "窦娥冤", "有日月朝暮悬"), cr("纳兰性德", "木兰词"),
}

// canonAlias 课本题名与库里题名的异名，仅列包含规则也套不住的。
// 琵琶行在库中题作「琵琶引」，其余异名跑一遍 -canon 再往这里补。
var canonAlias = map[string]string{
	"琵琶行":       "琵琶引",
	"渔歌子":       "渔父歌",
	"悯农":        "古风二首",
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

// luofuPrefix 是《全唐诗》的乐府类目名。乐府诗在库里题作「横吹曲辞 出塞 一」这种
// 「类目 + 本题 + 序号」的三段式，两字题名走前缀匹配就会被类目挡住：
// 「出塞」对不上「横吹曲辞出塞一」，王昌龄那首「秦时明月汉时关」整条清单条目落空。
// 匹配时把类目名剥掉再比一次。
var luofuPrefix = []string{
	"横吹曲辞", "杂曲歌辞", "相和歌辞", "鼓吹曲辞", "杂歌谣辞",
	"清商曲辞", "近代曲辞", "舞曲", "乐府", "新乐府",
}

// luofuKey 剥掉《全唐诗》的乐府类目名，返回「本题 + 序号」那一段：
// 「横吹曲辞 出塞 一」→「出塞一」。
func luofuKey(s string) string {
	k := normKey(s)
	for _, pre := range luofuPrefix {
		if strings.HasPrefix(k, pre) {
			return string([]rune(k)[len([]rune(pre)):])
		}
	}
	return k
}

// titleKeys 给出题名的两种匹配形式：原样，以及剥掉乐府类目名之后的本题。
func titleKeys(ti string) []string {
	k := normKey(ti)
	if s := luofuKey(ti); s != k {
		return []string{k, s}
	}
	return []string{k}
}

// displayTitle 是发布用的题名。课本目录里没有「杂曲歌辞」「横吹曲辞」这种类目名，
// 题面写《游子吟》《出塞》就够了——前缀是《全唐诗》的编排痕迹，不是诗名的一部分。
// 只改发布形式，匹配与去重仍按库里原题，免得同题不同抄本在这一层被误并。
func displayTitle(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	for _, pre := range luofuPrefix {
		if strings.HasPrefix(s, pre+" ") {
			return strings.TrimSpace(s[len(pre):])
		}
	}
	return s
}

// canonMatch 判断库里题名 ti 是否是课本题名 want 的同一个篇目。
//
// 库里的题名常带前缀或后缀（宫调「越调・天净沙秋思」、组诗序号「…六十首 其一」、
// 杂题副名「皇甫岳云溪杂题五首 鸟鸣涧」、词牌叠写「虞美人·虞美人·春花秋月」）。
// 因为调用方已经先用作者把候选缩到一个人的名下，题名只要「包含」课本篇目就足够定位，
// 不会跨作者误伤。三字以下（风、蝉、江雪）才要求以课本题名起头，避免「风」命中一堆。
func canonMatch(want, ti string) bool {
	w := normKey(want)
	if w == "" {
		return false
	}
	for _, t := range titleKeys(ti) {
		if t == "" {
			continue
		}
		if w == t || (len([]rune(w)) <= 2 && strings.HasPrefix(t, w)) ||
			(len([]rune(w)) > 2 && strings.Contains(t, w)) {
			return true
		}
	}
	return false
}

type canonReport struct {
	Matched map[int][]string
	Missed  map[int][]string
	Amb     map[int][]string // 同题多首且没写锚点的条目：靠题名长度取舍，需要人工定夺
}

// clausePos 返回锚点落在第几句（0 起），对不上给 -1。锚点取自语料本身，比对首三句。
//
// 取到位置而不只是「有没有对上」，是因为《全唐诗》给同一首诗另录的「又一体」
// 常常把课本首句挪到第二句：王维《使至塞上》的正本起「单车欲问边」，
// 另一体起「衔命辞天阙」而第二句还是「单车欲问边」。只判有无就把两本都收进必背位。
func clausePos(p *poem, fl string) int {
	for i, c := range head(p.clauses, 3) {
		if strings.HasPrefix(c, fl) {
			return i
		}
	}
	return -1
}

// bestCopy 在同题的几本里挑出该占必背位的那首，对不上锚点返回 nil。
//
// 先比锚点落在第几句：《全唐诗》另录的「又一体」会把课本首句挪到第二句
// （王维《使至塞上》一本起「单车欲问边」，一本起「衔命辞天阙」而第二句仍是
// 「单车欲问边」），只判锚点在不在首三句就会两本都收。
// 位置相同再比题名长短：李白《将进酒》在鼓吹曲辞与歌诗里各录一次，相差
// 尊/樽、杯/君几个字，留「将进酒」而不是「鼓吹曲辞 将进酒」。
func bestCopy(cands []*poem, fl string) *poem {
	var best *poem
	bestPos := 1 << 30
	for _, p := range cands {
		pos := clausePos(p, fl)
		if pos < 0 {
			continue
		}
		if best == nil || pos < bestPos || (pos == bestPos && lessCopy(p, best)) {
			best, bestPos = p, pos
		}
	}
	return best
}

func lessCopy(a, b *poem) bool {
	la, lb := len([]rune(a.Title)), len([]rune(b.Title))
	if la != lb {
		return la < lb
	}
	return a.score < b.score
}

// assignCanon 给每首诗标注它属于哪个课本档位的必背篇目，返回核对报告。
//
// 一个条目可能对上多首（组诗「悯农二首」，或同题《绝句》两首）。
// 写了首句锚点的按锚点定夺；没写的保留旧行为（题名短者优先、最多三首），
// 并记进 Amb 供 -canonamb 打出来人工补锚点。
func assignCanon(all []*poem) canonReport {
	byAuthor := map[string][]*poem{}
	for _, p := range all {
		k := normKey(p.Auth)
		byAuthor[k] = append(byAuthor[k], p)
	}

	rep := canonReport{Matched: map[int][]string{}, Missed: map[int][]string{}, Amb: map[int][]string{}}
	for tier, list := range map[int][]canonRef{tierPrimary: canonPrimary, tierJunior: canonJunior, tierSenior: canonSenior} {
		for _, ref := range list {
			var cands []*poem
			for _, p := range byAuthor[normKey(ref.au)] {
				if canonMatch(ref.ti, p.Title) || canonMatch(canonAlias[ref.ti], p.Title) {
					cands = append(cands, p)
				}
			}
			if len(cands) == 0 {
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

			var hits []*poem
			if ref.fl != "" {
				p := bestCopy(cands, ref.fl)
				if p == nil {
					var fl []string
					for _, q := range head(cands, 6) {
						fl = append(fl, fmt.Sprintf("%s=「%s」", q.Title, q.clauses[0]))
					}
					rep.Missed[tier] = append(rep.Missed[tier],
						fmt.Sprintf("%s《%s》 锚点「%s」在 %d 首同题诗里没对上：%v",
							ref.au, ref.ti, ref.fl, len(cands), strings.Join(fl, "  ")))
					continue
				}
				hits = []*poem{p}
			} else {
				hits = cands
				if len(cands) > 1 {
					var fl []string
					for _, q := range head(cands, 60) {
						fl = append(fl, fmt.Sprintf("%s=「%s」", q.Title, q.clauses[0]))
					}
					rep.Amb[tier] = append(rep.Amb[tier],
						fmt.Sprintf("%s《%s》 候选 %d 首：%v", ref.au, ref.ti, len(cands), strings.Join(fl, "  ")))
				}
			}

			// 没写锚点的条目仍可能对上多首（组诗、同题异作）：按上面的取舍排序，最多留三首。
			sort.SliceStable(hits, func(i, j int) bool { return lessCopy(hits[i], hits[j]) })
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

func (r canonReport) log(amb bool) {
	labels := map[int]string{tierPrimary: "小学", tierJunior: "初中", tierSenior: "高中"}
	for _, tier := range []int{tierPrimary, tierJunior, tierSenior} {
		total := []int{len(canonPrimary), len(canonJunior), len(canonSenior)}[tier-1]
		fmt.Printf("必背清单 %s：%d 条里 %d 条对上了，命中诗 %d 首\n",
			labels[tier], total, total-len(r.Missed[tier]), len(r.Matched[tier]))
		for _, s := range r.Missed[tier] {
			fmt.Printf("   缺 %s\n", s)
		}
		if amb {
			for _, s := range r.Amb[tier] {
				fmt.Printf("   歧 %s\n", s)
			}
		}
	}
}

func head[T any](s []T, n int) []T {
	if len(s) < n {
		return s
	}
	return s[:n]
}
