package main

import (
	"database/sql"
)

// row 是第二遍遍历时的单首诗词原始记录。
type row struct {
	id     int64
	title  string
	raw    string
	author string
	dyn    string
	tname  string
	bio    string
}

// scanPoems 只读正文，用于第一遍字频统计。
func scanPoems(db *sql.DB, fn func(raw string)) error {
	rows, err := db.Query(`SELECT content FROM poems_zh_hans`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		fn(raw)
	}
	return rows.Err()
}

// eachPoem 带上作者、朝代、体裁名与作者小传做第二遍遍历。
func eachPoem(db *sql.DB, fn func(r row)) error {
	q := `SELECT p.id, p.title, p.content,
			COALESCE(a.name,''), COALESCE(d.name,''), COALESCE(t.name,''),
			COALESCE(a.description,'')
		FROM poems_zh_hans p
		LEFT JOIN authors_zh_hans     a ON a.id = p.author_id
		LEFT JOIN dynasties_zh_hans   d ON d.id = p.dynasty_id
		LEFT JOIN poetry_types_zh_hans t ON t.id = p.type_id`
	rows, err := db.Query(q)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.title, &r.raw, &r.author, &r.dyn, &r.tname, &r.bio); err != nil {
			return err
		}
		fn(r)
	}
	return rows.Err()
}
