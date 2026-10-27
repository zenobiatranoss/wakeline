// runtime that instrumented go code calls into. owns the recording file,
// caps, and value encoding. must never interfere with program flow.

package main

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

type state struct {
	id        string
	name      string
	l0        int
	l1        int
	started   time.Time
	depth     int64
	steps     int64
	capped    bool
	capReason string
	ended     bool
	encoder   *encoder
	lastErr   interface{}
	returned  interface{}
	hasReturn bool
}

var (
	mu       sync.Mutex
	w        *writer
	opts     options
	broken   bool
	stopped  bool
	hardStop bool
	hit      string
	calls    int64
	nextID   int64
	active   int64
	maskList []string
)

type options struct {
	file      string
	out       string
	name      string
	line0     int
	line1     int
	maxCalls  int64
	maxEvents int64
	maxBytes  int64
	mask      string
}

func setOptions() {
	if opts.file != "" {
		return
	}
	opts.file = os.Getenv("wakeline_file")
	opts.out = os.Getenv("wakeline_out")
	opts.name = os.Getenv("wakeline_name")
	opts.line0 = toInt(os.Getenv("wakeline_line0"), 1)
	opts.line1 = toInt(os.Getenv("wakeline_line1"), 1)
	opts.maxCalls = toInt64(os.Getenv("wakeline_max_calls"), 100)
	opts.maxEvents = toInt64(os.Getenv("wakeline_max_events"), 10000)
	opts.maxBytes = toInt64(os.Getenv("wakeline_max_bytes"), 0)
	opts.mask = os.Getenv("wakeline_mask")
	maskList = compileMask(opts.mask)
	openWriter()
}

func compileMask(m string) []string {
	if m == "" {
		return nil
	}
	parts := strings.Split(m, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func isMasked(name string) bool {
	for _, p := range maskList {
		if matchGlob(p, name) {
			return true
		}
	}
	return false
}

func matchGlob(pat, name string) bool {
	if pat == "*" {
		return true
	}
	if !strings.Contains(pat, "*") && !strings.Contains(pat, "?") {
		return pat == name
	}
	// simple glob
	re := globToRE(pat)
	// use string match
	return reMatch(re, name)
}

func globToRE(p string) string {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(p); i++ {
		c := p[i]
		switch c {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		case '.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteString("$")
	return b.String()
}

func reMatch(pat, s string) bool {
	// cheap match for our needs
	// fall back to simple prefix/suffix
	if strings.Contains(pat, ".*") {
		p := strings.Trim(pat, "^$")
		// split on .*
		parts := strings.Split(p, ".*")
		idx := 0
		for _, part := range parts {
			if part == "" {
				continue
			}
			i := strings.Index(s[idx:], part)
			if i < 0 {
				return false
			}
			idx += i + len(part)
		}
		return true
	}
	// exact after trim
	p := strings.Trim(pat, "^$")
	return p == s
}

func openWriter() {
	if w != nil || broken {
		return
	}
	if opts.out == "" {
		broken = true
		return
	}
	var err error
	w, err = newWriter(opts.out, opts.maxBytes)
	if err != nil {
		broken = true
		fmt.Fprintf(os.Stderr, "wakeline: cannot write recording at %s: %s\n", opts.out, err)
		return
	}
	w.write(map[string]interface{}{"k": "ver", "v": 1}, true)
	w.write(map[string]interface{}{"k": "meta", "src": opts.file, "sm": sourceMtime(opts.file)}, true)
}

func sourceMtime(f string) int64 {
	st, err := os.Stat(f)
	if err != nil {
		return 0
	}
	return st.ModTime().UnixMilli()
}

func toInt(s string, d ...int) int {
	def := 0
	if len(d) > 0 {
		def = d[0]
	}
	if s == "" {
		return def
	}
	var v int
	n, _ := fmt.Sscanf(s, "%d", &v)
	if n == 0 {
		return def
	}
	return v
}

func toInt64(s string, d int64) int64 {
	if s == "" {
		return d
	}
	var v int64
	fmt.Sscanf(s, "%d", &v)
	if v == 0 && s != "0" {
		return d
	}
	return v
}

func failure(where, why string) {
	mu.Lock()
	defer mu.Unlock()
	if w == nil || broken {
		return
	}
	msg := why
	if len(msg) > 500 {
		msg = msg[:500]
	}
	w.write(map[string]interface{}{"k": "failure", "why": msg, "where": where}, true)
	broken = true
	hardStop = true
}

func Enter(name string, line0, line1 int, args map[string]interface{}) *state {
	setOptions()
	mu.Lock()
	defer mu.Unlock()
	if w == nil || broken || hardStop {
		return nil
	}
	if stopped || calls >= opts.maxCalls {
		capLocked("max_calls", nil)
		return nil
	}
	id := fmt.Sprintf("c%d", nextID)
	nextID++
	calls++
	depth := active
	active++
	enc := newEncoder()
	encArgs := map[string]interface{}{}
	for k, v := range args {
		if isMasked(k) {
			encArgs[k] = map[string]interface{}{"$": "opaque", "cls": "masked", "why": "masked"}
		} else {
			encArgs[k] = enc.encode(v)
		}
	}
	st := &state{
		id:        id,
		name:      name,
		l0:        line0,
		l1:        line1,
		started:   time.Now(),
		depth:     depth,
		encoder:   enc,
		capReason: "none",
		returned:  nil,
		hasReturn: false,
	}
	if name == "" {
		name = opts.name
	}
	ok := writeLocked(map[string]interface{}{
		"k":  "call_start",
		"i":  st.id,
		"f":  name,
		"l0": line0,
		"l1": line1,
		"dp": depth,
		"a":  encArgs,
		"t":  st.started.UnixMilli(),
	}, st, false)
	if !ok {
		active--
		return nil
	}
	return st
}

func At(st *state, line int, capture func() map[string]interface{}) {
	if st == nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if st.ended || st.capped || hardStop {
		return
	}
	if st.steps >= opts.maxEvents {
		capEventsLocked(st)
		return
	}
	raw := map[string]interface{}{}
	if capture != nil {
		func() {
			defer func() {
				recover()
			}()
			raw = capture()
			if raw == nil {
				raw = map[string]interface{}{}
			}
		}()
	}
	vals := map[string]interface{}{}
	for k, v := range raw {
		if isMasked(k) {
			vals[k] = map[string]interface{}{"$": "opaque", "cls": "masked", "why": "masked"}
		} else {
			vals[k] = st.encoder.encode(v)
		}
	}
	if writeLocked(map[string]interface{}{"k": "line", "i": st.id, "s": st.steps, "l": line, "v": vals}, st, false) {
		st.steps++
	}
}

func Ret(st *state, v interface{}) interface{} {
	if st != nil {
		st.returned = v
		st.hasReturn = true
	}
	return v
}

func Thrown(st *state, v interface{}) interface{} {
	recordException(st, v)
	return v
}

func Err(st *state, v interface{}) {
	if st == nil {
		return
	}
	st.lastErr = v
	recordException(st, v)
}

func End(st *state) {
	if st == nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if st.ended {
		return
	}
	st.ended = true
	var ev map[string]interface{}
	if st.lastErr != nil {
		ev = map[string]interface{}{
			"k":  "call_end",
			"i":  st.id,
			"s":  st.steps,
			"o":  "throw",
			"x":  exceptionInfo(st.lastErr),
			"ms": time.Since(st.started).Milliseconds(),
			"c":  st.capReason,
		}
	} else {
		var r interface{}
		if st.hasReturn {
			r = st.encoder.encode(st.returned)
		} else {
			r = nil
		}
		ev = map[string]interface{}{
			"k":  "call_end",
			"i":  st.id,
			"s":  st.steps,
			"o":  "return",
			"r":  r,
			"ms": time.Since(st.started).Milliseconds(),
			"c":  st.capReason,
		}
	}
	writeLocked(ev, st, true)
	if w != nil {
		w.flush()
	}
	active--
	if active < 0 {
		active = 0
	}
}

func capEventsLocked(st *state) {
	if st.capped {
		return
	}
	st.capped = true
	st.capReason = "max_events"
	writeLocked(map[string]interface{}{"k": "cap_hit", "i": st.id, "r": "max_events", "s": st.steps, "b": bytesWritten()}, st, true)
}

func capLocked(reason string, st *state) {
	if hit != "" {
		return
	}
	hit = reason
	if reason == "max_calls" || reason == "max_bytes" {
		stopped = true
	}
	if reason == "max_bytes" {
		hardStop = true
	}
	ev := map[string]interface{}{"k": "cap_hit", "r": reason, "b": bytesWritten()}
	if st != nil {
		ev["i"] = st.id
		ev["s"] = st.steps
	}
	writeLocked(ev, st, true)
	if w != nil {
		w.flush()
	}
}

func writeLocked(ev map[string]interface{}, st *state, force bool) bool {
	if w == nil || broken {
		return false
	}
	if hardStop && !force {
		return false
	}
	n := w.write(ev, force)
	if n < 0 {
		capLocked("max_bytes", st)
		return false
	}
	return true
}

func bytesWritten() int64 {
	if w == nil {
		return 0
	}
	return w.bytes()
}

func recordException(st *state, v interface{}) {
	if st == nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if st.lastErr == v {
		return
	}
	st.lastErr = v
	writeLocked(map[string]interface{}{"k": "exception", "i": st.id, "x": exceptionInfo(v)}, st, false)
}

func exceptionInfo(v interface{}) map[string]interface{} {
	name := "Error"
	msg := ""
	var frames []string
	if v != nil {
		name = fmt.Sprintf("%T", v)
		msg = fmt.Sprintf("%v", v)
		if len(msg) > 1000 {
			msg = msg[:1000]
		}
		buf := make([]byte, 4096)
		n := runtime.Stack(buf, false)
		lines := strings.Split(string(buf[:n]), "\n")
		for _, l := range lines {
			l = strings.TrimSpace(l)
			if strings.HasPrefix(l, "goroutine") {
				continue
			}
			if l != "" && len(frames) < 20 {
				frames = append(frames, l)
			}
		}
	}
	return map[string]interface{}{"t": name, "m": msg, "s": frames}
}

// extras attached to state
func (s *state) setReturned(v interface{}) {
	s.returned = v
	s.hasReturn = true
}

var _ = fmt.Sprintf
