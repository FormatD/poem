package main

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// 作者小传里有结构化的字、号信息（「李白，字太白，陇西成纪人」「苏轼（一○三七～一一○一），
// 字子瞻，一字和仲，自号东坡居士」），可以稳定抽出来做「作者之字」这类题。
// 只取小传开头的自述部分：中段出现的「字」多是引文里的动词（「其书字兼……」）。
var (
	reZi  = regexp.MustCompile(`^[^，。；]{0,24}[，、]字([^，。；、]{1,6})`)
	reHao = regexp.MustCompile(`^[^，。；]{0,40}[，、]?(?:自号|别号|又号|号)([^，。；、]{2,8})`)
)

// badZi 拦掉转换噪声：抓到的「字」里出现这些说明其实不是表字。
var badZi = []string{"年", "谥", "集", "卷", "仕", "于", "之曰", "若"}

func extractZiHao(bio string) (zi, hao string) {
	if bio == "" {
		return "", ""
	}
	head := bio
	if len([]rune(head)) > 120 {
		head = string([]rune(head)[:120])
	}
	if m := reZi.FindStringSubmatch(head); m != nil {
		cand := strings.TrimSpace(m[1])
		if utf8.RuneCountInString(cand) >= 1 && !containsAny(cand, badZi) && isAllHan(cand) {
			zi = cand
		}
	}
	if m := reHao.FindStringSubmatch(head); m != nil {
		cand := strings.TrimSpace(m[1])
		if !containsAny(cand, badZi) && isAllHan(cand) {
			hao = cand
		}
	}
	return zi, hao
}

func containsAny(s string, subs []string) bool {
	for _, t := range subs {
		if strings.Contains(s, t) {
			return true
		}
	}
	return false
}

func isAllHan(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !isHan(r) {
			return false
		}
	}
	return true
}
