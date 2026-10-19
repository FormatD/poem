package main

import "strings"

// 简体表里剩下的不是繁体，是日本新字体／CJK 变体：隠、聴、壊、歳 这一批。
// 它们和繁体的关系不在 t2s 表里（繁简两边都把它当它自己），所以转换漏网，
// 实测每个档位 1–27 处，会出现在「夜阑卧聴风吹雨」这种必背篇目里。
// 只能按字替换，不能整篇转换：t2s 会把「乾坤」整首剔掉，因为它的干支映射不可逆。
var hanVariant = map[rune]rune{
	'隠': '隐', '聴': '听', '壊': '坏', '懐': '怀', '歳': '岁', '変': '变',
	'関': '关', '顕': '显', '実': '实', '楽': '乐', '対': '对', '図': '图',
	'浄': '净', '竪': '竖', '粛': '肃', '廻': '回', '閲': '阅', '砕': '碎',
	'恵': '惠', '応': '应',
	// 漏网的繁体与通行异体字（都是字书里认得的对应关系，不改变词义）
	'車': '车', '環': '环', '來': '来', '衆': '众', '顒': '颙', '讌': '宴',
	'羗': '羌', '冦': '寇', '嬾': '懒', '輭': '软', '氊': '毡',
}

func fixVariant(s string) string {
	if strings.IndexFunc(s, func(r rune) bool { _, ok := hanVariant[r]; return ok }) < 0 {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if v, ok := hanVariant[r]; ok {
			r = v
		}
		b.WriteRune(r)
	}
	return b.String()
}
