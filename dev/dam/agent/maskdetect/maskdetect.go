// Package maskdetect decides whether a column's stored values are already masked/redacted at rest
// (static masking, tokenised storage, or app-side redaction) so they aren't reported as
// dynamic-masking gaps. Extracted from the agent's main package so it can be unit-tested without
// the eBPF/syscall build constraints that keep `package main` from compiling in a plain toolchain.
package maskdetect

import (
	"regexp"
	"strings"
)

// Signatures (deliberately conservative to avoid false positives on real data):
//   - a run of 3+ hard fill chars  * # • ●  → ****1234, 4111********1111
//   - a run of 3+ X (upper or lower)        → XXX-XX-6789, xxxxxxxx
//   - an explicit redaction marker          → REDACTED, [MASKED], ***REDACTED***
//
// The >=80% column threshold + sensitive-only scope keep the 3-run X rule from mis-flagging names.
var (
	reMaskFill   = regexp.MustCompile(`[*#•●]{3,}`)
	reMaskX      = regexp.MustCompile(`(?i)x{3,}`)
	reMaskMarker = regexp.MustCompile(`(?i)^\s*[\[*]*\s*(redacted|masked|restricted)\s*[\]*]*\s*$`)
)

// LooksMasked reports whether a single value carries a masking signature, and which kind.
func LooksMasked(v string) (bool, string) {
	if reMaskMarker.MatchString(v) {
		return true, "marker"
	}
	if reMaskFill.MatchString(v) || reMaskX.MatchString(v) {
		return true, "redaction"
	}
	return false, ""
}

// Detect returns whether the sampled values are dominated by masked-looking values. It needs a
// meaningful sample (>=8 non-empty) and a >=80% hit rate before it will claim "masked".
func Detect(values []string) (bool, string) {
	n, hit := 0, 0
	method := ""
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		n++
		if ok, m := LooksMasked(v); ok {
			hit++
			if method == "" {
				method = m
			}
		}
	}
	if n < 8 {
		return false, ""
	}
	if float64(hit)/float64(n) >= 0.8 {
		return true, method
	}
	return false, ""
}

// QuoteIdent escapes a SQL identifier for the given driver's quoting style.
func QuoteIdent(driver, id string) string {
	switch driver {
	case "mysql":
		return "`" + strings.ReplaceAll(id, "`", "``") + "`"
	case "sqlserver":
		return "[" + strings.ReplaceAll(id, "]", "]]") + "]"
	default: // postgres, oracle — ANSI double-quote
		return `"` + strings.ReplaceAll(id, `"`, `""`) + `"`
	}
}
