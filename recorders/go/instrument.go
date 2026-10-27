package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"strings"
)

type target struct {
	name  string
	line0 int
	line1 int
	file  string
}

func instrumentSource(src []byte, t target) ([]byte, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, t.file, src, parser.ParseComments)
	if err != nil {
		return nil, err
	}

	// find the function whose range covers line0:line1
	var fn *ast.FuncDecl
	var fnLit *ast.FuncLit
	ast.Inspect(f, func(n ast.Node) bool {
		if n == nil {
			return false
		}
		switch x := n.(type) {
		case *ast.FuncDecl:
			start := fset.Position(x.Pos()).Line
			end := fset.Position(x.End()).Line
			if start == t.line0 && end == t.line1 {
				fn = x
				return false
			}
			if start <= t.line0 && end >= t.line0 && (t.name == "" || x.Name.Name == t.name || strings.HasSuffix(t.name, "."+x.Name.Name)) {
				fn = x
				return false
			}
			if start <= t.line0 && end >= t.line0 {
				fn = x
			}
		case *ast.FuncLit:
			start := fset.Position(x.Pos()).Line
			end := fset.Position(x.End()).Line
			if start <= t.line0 && end >= t.line0 {
				fnLit = x
			}
		}
		return true
	})

	if fn == nil && fnLit == nil {
		return nil, fmt.Errorf("function not found near line %d", t.line0)
	}

	// assign scope ids to locals/params
	scope := map[string]bool{}
	var params []string
	var body *ast.BlockStmt
	if fn != nil {
		if fn.Recv != nil {
			for _, f := range fn.Recv.List {
				for _, n := range f.Names {
					if n != nil {
						scope[n.Name] = true
					}
				}
			}
		}
		if fn.Type.Params != nil {
			for _, p := range fn.Type.Params.List {
				for _, n := range p.Names {
					if n != nil {
						scope[n.Name] = true
						params = append(params, n.Name)
					}
				}
			}
		}
		if fn.Type.Results != nil {
			for _, r := range fn.Type.Results.List {
				for _, n := range r.Names {
					if n != nil {
						scope[n.Name] = true
					}
				}
			}
		}
		body = fn.Body
	} else {
		body = fnLit.Body
	}
	if body == nil {
		return nil, fmt.Errorf("no body")
	}

	// collect locals declared in body
	ast.Inspect(body, func(n ast.Node) bool {
		if n == nil {
			return false
		}
		if as, ok := n.(*ast.AssignStmt); ok && as.Tok == token.DEFINE {
			for _, lh := range as.Lhs {
				if id, ok := lh.(*ast.Ident); ok && id.Name != "_" {
					scope[id.Name] = true
				}
			}
		}
		if ds, ok := n.(*ast.DeclStmt); ok {
			if gd, ok := ds.Decl.(*ast.GenDecl); ok && gd.Tok == token.VAR {
				for _, sp := range gd.Specs {
					if vs, ok := sp.(*ast.ValueSpec); ok {
						for _, n := range vs.Names {
							if n.Name != "_" {
								scope[n.Name] = true
							}
						}
					}
				}
			}
		}
		if rs, ok := n.(*ast.RangeStmt); ok && rs.Tok == token.DEFINE {
			if id, ok := rs.Key.(*ast.Ident); ok && id.Name != "_" {
				scope[id.Name] = true
			}
			if id, ok := rs.Value.(*ast.Ident); ok && id.Name != "_" {
				scope[id.Name] = true
			}
		}
		return true
	})

	// build args map string
	var argPairs []string
	for _, p := range params {
		argPairs = append(argPairs, fmt.Sprintf("%q: %s", p, p))
	}
	argsStr := "map[string]interface{}{" + strings.Join(argPairs, ",") + "}"

	// wrap body: enter, try, and tick at each statement line
	// we insert statements; easier to rebuild with printer by editing text
	// do text replacement on the original source
	srcStr := string(src)

		funcName := t.name
	if fn != nil {
		if fn.Recv != nil {
			for _, f := range fn.Recv.List {
				tp := f.Type
				if star, ok := tp.(*ast.StarExpr); ok {
					tp = star.X
				}
				if id, ok := tp.(*ast.Ident); ok {
					funcName = id.Name + "." + fn.Name.Name
					break
				}
			}
		} else if funcName == "" || !strings.Contains(funcName, ".") {
			funcName = fn.Name.Name
		}
	}

	// insert at start of body
	bodyStart := body.Pos()
	bodyStartPos := fset.Position(bodyStart)
	// find { at bodyStartPos.Offset
	offset := bodyStartPos.Offset
	// advance to {
	for offset < len(srcStr) && srcStr[offset] != '{' {
		offset++
	}
	offset++ // past {

	enter := fmt.Sprintf("\n\t__wk_state__ := Enter(%q, %d, %d, %s)\n\tif __wk_state__ != nil { defer End(__wk_state__) }\n\tvar __wk_ret__ interface{}\n\t_ = __wk_ret__\n", funcName, t.line0, t.line1, argsStr)

	// insert enter
	srcStr = srcStr[:offset] + enter + srcStr[offset:]

	// rebuild fset after insertion
	fset2 := token.NewFileSet()
	f2, err := parser.ParseFile(fset2, t.file, srcStr, parser.ParseComments)
	if err != nil {
		return nil, err
	}
	var body2 *ast.BlockStmt
	if fn != nil {
		ast.Inspect(f2, func(n ast.Node) bool {
			if n == nil {
				return false
			}
			if x, ok := n.(*ast.FuncDecl); ok && x.Name.Name == fn.Name.Name {
				body2 = x.Body
				return false
			}
			return true
		})
	} else {
		ast.Inspect(f2, func(n ast.Node) bool {
			if n == nil {
				return false
			}
			if _, ok := n.(*ast.FuncLit); ok {
				body2 = body
				return false
			}
			return true
		})
	}
	if body2 == nil {
		body2 = body
	}

	var buf strings.Builder
	printer.Fprint(&buf, fset2, f2)
	result := buf.String()
	return []byte(result), nil
}
