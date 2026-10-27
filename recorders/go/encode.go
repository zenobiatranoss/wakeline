package main

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"unicode/utf8"
)

type encoder struct {
	ids  map[uintptr]int
	next int
}

func newEncoder() *encoder {
	return &encoder{ids: map[uintptr]int{}, next: 1}
}

func (e *encoder) encode(v interface{}) interface{} {
	return e.encodeDepth(v, 0)
}

func (e *encoder) encodeDepth(v interface{}, depth int) interface{} {
	if depth > 4 {
		return map[string]interface{}{"$": "trunc", "why": "depth"}
	}
	if v == nil {
		return nil
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Bool:
		return rv.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		i := rv.Int()
		if i > 9007199254740991 || i < -9007199254740991 {
			return map[string]interface{}{"$": "int", "v": fmt.Sprintf("%d", i)}
		}
		return i
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		u := rv.Uint()
		if u > 9007199254740991 {
			return map[string]interface{}{"$": "int", "v": fmt.Sprintf("%d", u)}
		}
		return float64(u)
	case reflect.Float32, reflect.Float64:
		f := rv.Float()
		if math.IsNaN(f) {
			return map[string]interface{}{"$": "num", "v": "nan"}
		}
		if math.IsInf(f, 0) {
			if f > 0 {
				return map[string]interface{}{"$": "num", "v": "inf"}
			}
			return map[string]interface{}{"$": "num", "v": "-inf"}
		}
		return f
	case reflect.String:
		s := rv.String()
		if len(s) > 4096 {
			return map[string]interface{}{"$": "str", "v": s[:4096], "n": len(s), "cut": true}
		}
		if utf8.RuneCountInString(s) > 4096 {
			r := []rune(s)
			return map[string]interface{}{"$": "str", "v": string(r[:4096]), "n": len(s), "cut": true}
		}
		return s
	case reflect.Slice, reflect.Array:
		if rv.Type().Elem().Kind() == reflect.Uint8 {
			b := rv.Bytes()
			if len(b) > 1024*1024 {
				return map[string]interface{}{"$": "bytes", "v": string(b[:1024]), "n": len(b), "cut": true}
			}
			return map[string]interface{}{"$": "bytes", "v": string(b), "n": len(b), "cut": false}
		}
		id := e.getID(rv)
		n := rv.Len()
		cut := false
		limit := 100
		if n > limit {
			n = limit
			cut = true
		}
		items := make([]interface{}, 0, n)
		for i := 0; i < n; i++ {
			items = append(items, e.encodeDepth(rv.Index(i).Interface(), depth+1))
		}
		return map[string]interface{}{"$": "list", "id": id, "v": items, "n": rv.Len(), "cut": cut}
	case reflect.Map:
		id := e.getID(rv)
		keys := rv.MapKeys()
		n := len(keys)
		cut := false
		limit := 50
		if n > limit {
			n = limit
			cut = true
		}
		pairs := make([][]interface{}, 0, n)
		for i := 0; i < n; i++ {
			k := keys[i]
			var kk interface{}
			if k.Kind() == reflect.String {
				kk = k.String()
			} else {
				kk = e.encodeDepth(k.Interface(), depth+1)
			}
			pairs = append(pairs, []interface{}{kk, e.encodeDepth(rv.MapIndex(k).Interface(), depth+1)})
		}
		return map[string]interface{}{"$": "dict", "id": id, "v": pairs, "n": len(keys), "cut": cut}
	case reflect.Struct:
		id := e.getID(rv)
		t := rv.Type()
		out := map[string]interface{}{}
		count := 0
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if f.PkgPath != "" {
				continue
			}
			if count >= 100 {
				break
			}
			out[f.Name] = e.encodeDepth(rv.Field(i).Interface(), depth+1)
			count++
		}
		return map[string]interface{}{"$": "obj", "id": id, "cls": t.Name(), "v": out, "n": count, "cut": count >= 100}
	case reflect.Ptr, reflect.Interface:
		if rv.IsNil() {
			return nil
		}
		// cycles are tracked by address
		id := e.getID(rv)
		if rv.Elem().Kind() == reflect.Struct {
			// encode the struct, keep id
			t := rv.Elem().Type()
			out := map[string]interface{}{}
			ev := rv.Elem()
			for i := 0; i < t.NumField() && len(out) < 100; i++ {
				f := t.Field(i)
				if f.PkgPath != "" {
					continue
				}
				out[f.Name] = e.encodeDepth(ev.Field(i).Interface(), depth+1)
			}
			return map[string]interface{}{"$": "obj", "id": id, "cls": t.Name(), "v": out, "n": len(out), "cut": false}
		}
		return e.encodeDepth(rv.Elem().Interface(), depth+1)
	case reflect.Func:
		return map[string]interface{}{"$": "fn", "name": rv.Type().String()}
	default:
		// try json as a fallback
		b, err := json.Marshal(v)
		if err != nil {
			return map[string]interface{}{"$": "opaque", "cls": rv.Type().String(), "why": "repr failed"}
		}
		var x interface{}
		json.Unmarshal(b, &x)
		return x
	}
}

func (e *encoder) getID(rv reflect.Value) int {
	if rv.CanInterface() {
		p := rv.Pointer()
		if p == 0 {
			return 0
		}
		if id, ok := e.ids[p]; ok {
			return -id // signal ref? we handle in caller
		}
		e.next++
		e.ids[p] = e.next
		return e.next
	}
	e.next++
	return e.next
}

func clamp(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// try to cut on rune boundary
	if !utf8.ValidString(s[:n]) {
		for n > 0 && !utf8.RuneStart(s[n]) {
			n--
		}
	}
	return s[:n] + strings.Repeat(".", 0)
}

var _ = math.NaN

func (e *encoder) encodeString(s string) interface{} {
	if len(s) > 4096 {
		return map[string]interface{}{"$": "str", "v": s[:4096], "n": len(s), "cut": true}
	}
	return s
}
