package maskdetect

import "testing"

func TestLooksMasked(t *testing.T) {
	cases := []struct {
		v      string
		masked bool
	}{
		{"XXX-XX-1234", true},         // 3-run X (canonical SSN mask)
		{"****1234", true},            // star fill
		{"4111********1111", true},    // partial card reveal
		{"••••1234", true},            // bullet fill
		{"REDACTED", true},            // marker
		{"[MASKED]", true},            // bracketed marker
		{"asha.k@example.com", false}, // real email (single x)
		{"John Smith", false},         // real name
		{"4111111111111111", false},   // unmasked PAN
		{"", false},                   // empty
	}
	for _, c := range cases {
		if got, _ := LooksMasked(c.v); got != c.masked {
			t.Errorf("LooksMasked(%q) = %v, want %v", c.v, got, c.masked)
		}
	}
}

func TestDetect(t *testing.T) {
	masked := []string{"XXX-XX-4821", "XXX-XX-1902", "XXX-XX-7734", "XXX-XX-0056",
		"XXX-XX-6621", "XXX-XX-9987", "XXX-XX-4410", "XXX-XX-3325"}
	if ok, method := Detect(masked); !ok || method != "redaction" {
		t.Errorf("Detect(masked SSNs) = %v/%q, want true/redaction", ok, method)
	}

	real := []string{"a@x.com", "b@y.com", "c@z.com", "d@x.com",
		"e@y.com", "f@z.com", "g@x.com", "h@y.com"}
	if ok, _ := Detect(real); ok {
		t.Error("Detect(real emails) = true, want false")
	}

	// Fewer than 8 non-empty samples → not confident enough, even if all look masked.
	if ok, _ := Detect([]string{"****", "****", "****"}); ok {
		t.Error("Detect(<8 samples) = true, want false")
	}

	// Below the 80% threshold (4 of 8 masked) → not flagged.
	mix := []string{"XXX-XX-1", "XXX-XX-2", "XXX-XX-3", "XXX-XX-4", "realA", "realB", "realC", "realD"}
	if ok, _ := Detect(mix); ok {
		t.Error("Detect(50% masked) = true, want false")
	}

	// Whitespace/empty values are ignored in the count.
	if ok, _ := Detect([]string{"", "  ", "REDACTED"}); ok {
		t.Error("Detect(mostly blank) = true, want false")
	}
}

func TestQuoteIdent(t *testing.T) {
	cases := []struct{ driver, id, want string }{
		{"mysql", "col", "`col`"},
		{"mysql", "a`b", "`a``b`"},       // backtick doubled
		{"sqlserver", "col", "[col]"},
		{"sqlserver", "a]b", "[a]]b]"},   // bracket doubled
		{"postgres", "col", `"col"`},
		{"postgres", `a"b`, `"a""b"`},    // quote doubled
		{"oracle", "col", `"col"`},       // ANSI default
	}
	for _, c := range cases {
		if got := QuoteIdent(c.driver, c.id); got != c.want {
			t.Errorf("QuoteIdent(%q, %q) = %q, want %q", c.driver, c.id, got, c.want)
		}
	}
}
