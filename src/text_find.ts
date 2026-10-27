// pure text based function detection. no language server, no parser: a few
// regexes and a brace matcher that skips strings and comments. it is the
// fallback when the symbol provider cannot answer, and it is also what the
// tests use because it needs nothing but a string.

export type found_function = {
  name: string;
  line0: number;
  line1: number;
};

// words that look like a function call to the method regex but are not names.
// without this, `if (x) {` would be reported as a method called if.
const js_reserved = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "new",
  "typeof",
  "class",
  "const",
  "let",
  "var",
  "async",
  "await",
]);

export function find_function_in_text(text: string, at: number, lang: string): found_function | null {
  if (lang === "python") return python_function(text, at);
  if (lang === "go") return go_function(text, at);
  if (lang === "csharp") return csharp_function(text, at);
  if (lang === "cpp" || lang === "c") return cpp_function(text, at);
  // javascript and typescript share almost all of their syntax, so the same
  // scanner handles both. the extra patterns below only ever match ts.
  return javascript_function(text, at);
}

type block = {
  name: string;
  line: number;
  end: number;
  indent: number;
  kind: string;
};

// python has no braces, so the block ends at the first non-blank line whose
// indentation is not deeper than the def. classes are tracked too so a method
// comes back as class.method.
function python_function(text: string, at: number): found_function | null {
  const lines = text.split(/\r?\n/);
  const blocks: block[] = [];
  for (let i = 0; i <= at && i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (blocks.length && indent <= blocks[blocks.length - 1].indent) blocks.pop();
    const is_def = /(?:async\s+)?def\b/.test(m[2]);
    blocks.push({ name: m[3], line: i, end: i, indent, kind: is_def ? "def" : "class" });
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== "def" || b.line > at) continue;
    let end = b.line;
    for (let j = b.line + 1; j < lines.length; j++) {
      const s = lines[j];
      if (!s.trim()) continue;
      const indent = s.length - s.trimStart().length;
      if (indent <= b.indent) break;
      end = j;
    }
    if (at <= end) {
      const enclosing = blocks.slice(0, i + 1).map((x) => x.name);
      return { name: enclosing.join("."), line0: b.line + 1, line1: end + 1 };
    }
  }
  return null;
}

type js_candidate = {
  name: string;
  start: number;
  end: number;
  kind: string;
};

// collect every plausible function, then pick the smallest one containing the
// line. the prefix logic is what turns an inner function into outer.inner.
function javascript_function(text: string, at: number): found_function | null {
  const candidates = js_candidates(text);
  const hits = candidates.filter((c) => c.start <= at && c.end >= at && c.name);
  if (!hits.length) return null;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const target = hits[hits.length - 1];
  // nested functions get the outer name; methods already carry their class
  const prefix = hits
    .filter((c) => c !== target && c.start <= target.start && c.end >= target.end && c.kind !== "method")
    .map((c) => c.name);
  return { name: [...prefix, target.name].join("."), line0: target.start + 1, line1: target.end + 1 };
}

type named_candidate = {
  name: string;
  start: number;
  end: number;
};

// every non-js scanner ends here. the innermost function that covers the line
// wins, which is what you want for a method inside a class or a closure inside
// another function. start and end are zero based lines.
function pick_smallest(candidates: named_candidate[], at: number): found_function | null {
  const hits = candidates.filter((c) => c.start <= at && c.end >= at);
  if (!hits.length) return null;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const target = hits[hits.length - 1];
  return { name: target.name, line0: target.start + 1, line1: target.end + 1 };
}

// go has receiver syntax instead of a class prefix, so a method comes back as
// `type.name`. a plain function keeps just its name.
function go_function(text: string, at: number): found_function | null {
  const out: named_candidate[] = [];
  const re = /^[ \t]*func\s+(?:\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)\s*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/gm;
  for (const m of text.matchAll(re)) {
    const receiver = m[1];
    const name = receiver ? `${receiver}.${m[2]}` : m[2];
    const open = body_brace(text, m.index);
    if (open < 0) continue;
    const close = match_brace(text, open);
    if (close < 0) continue;
    out.push({ name, start: line_at(text, m.index), end: line_at(text, close) });
  }
  return pick_smallest(out, at);
}

// c# headers are long and full of modifiers, attributes and generics. rather
// than trying to spell all of that in one regex, grab the whole header up to
// its body and pull the name out of the part before the first parenthesis.
const cs_skip = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "catch",
  "using",
  "lock",
  "return",
  "new",
  "throw",
  "when",
  "base",
  "this",
  "typeof",
  "sizeof",
  "nameof",
  "default",
  "checked",
  "unchecked",
  "fixed",
  "unsafe",
  "do",
  "else",
  "get",
  "set",
  "add",
  "remove",
  "operator",
  "delegate",
]);

function csharp_function(text: string, at: number): found_function | null {
  const out: named_candidate[] = [];
  const re = /^([ \t]*)([^;{}\n]*?\([^;{}\n]*\))\s*(?:where[^{;]*)?(?:\{|=>)/gm;
  for (const m of text.matchAll(re)) {
    const head = m[2];
    const paren = head.indexOf("(");
    if (paren < 0) continue;
    // drop a generic parameter list at the end, then take the last word before
    // the paren. that word is the method name even with a long return type.
    const before = head.slice(0, paren).replace(/<[^>]*>\s*$/, "").trim();
    const name = before.split(/[\s*&]+/).pop() ?? "";
    if (!name || cs_skip.has(name) || !/^[A-Za-z_]\w*$/.test(name)) continue;

    const arrow = m[0].trimEnd().endsWith("=>");
    let close = -1;
    if (arrow) {
      close = semicolon_end(text, m.index + m[0].length);
    } else {
      const brace = m[0].lastIndexOf("{");
      if (brace < 0) continue;
      close = match_brace(text, m.index + brace);
    }
    if (close < 0) continue;
    out.push({ name, start: line_at(text, m.index), end: line_at(text, close) });
  }
  return pick_smallest(out, at);
}

// c++ was the awkward one. a brace does not tell you whether it starts a
// function, a namespace, a class or an initializer, so walk the braces that are
// real code, look back for a closing paren, and take the identifier in front of
// it. anything that smells like a keyword is dropped.
const cpp_skip = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "else",
  "do",
  "try",
  "namespace",
  "class",
  "struct",
  "enum",
  "union",
  "extern",
  "return",
  "new",
  "delete",
  "throw",
  "case",
  "sizeof",
  "alignof",
  "decltype",
  "static_assert",
  "template",
  "using",
]);

function cpp_function(text: string, at: number): found_function | null {
  const mask = code_mask(text);
  const out: named_candidate[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" || !mask[i]) continue;
    const name = cpp_name_before(text, i, mask);
    if (!name) continue;
    const close = match_brace(text, i);
    if (close < 0) continue;
    out.push({ name: name.text, start: line_at(text, name.at), end: line_at(text, close) });
  }
  return pick_smallest(out, at);
}

function cpp_name_before(text: string, brace: number, mask: boolean[]): { text: string; at: number } | null {
  // skip trailing qualifiers between the paren and the brace. a `:` in that
  // gap usually means a constructor initializer list; the name we want is
  // before the first paren of the declaration, so keep walking back.
  let j = brace - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  const words = /(?:const|noexcept|override|final|volatile|mutable|&|&&)\s*$/;
  for (;;) {
    const tail = text.slice(Math.max(0, j - 16), j + 1);
    const m = words.exec(tail);
    if (!m) break;
    j -= m[0].length;
    while (j >= 0 && /\s/.test(text[j])) j--;
  }
  if (j < 0 || text[j] !== ")" || !mask[j]) return null;
  const open = match_paren_back(text, j, mask);
  if (open < 0) return null;

  const before = text.slice(0, open).trimEnd();
  const m = /([~A-Za-z_]\w*(?:::[~A-Za-z_]\w*)*|operator\s*[^\s(]+)\s*$/.exec(before);
  if (!m) return null;
  const name = m[1].trim();
  if (cpp_skip.has(name)) return null;
  return { text: name, at: m.index };
}

function match_paren_back(text: string, close: number, mask: boolean[]): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (!mask[i]) continue;
    if (text[i] === ")") depth++;
    else if (text[i] === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// same idea as match_brace but for an expression body that ends at a semicolon.
// newlines do not end it, because a c# expression body can wrap.
function semicolon_end(text: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth <= 0 && ch === ";") return i;
  }
  return text.length - 1;
}

// which characters are actual c++ code. braces and parens inside comments or
// string literals must not confuse the backward scan.
function code_mask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(true);
  let quote = "";
  let line_comment = false;
  let block_comment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (line_comment) {
      mask[i] = false;
      if (ch === "\n") line_comment = false;
      continue;
    }
    if (block_comment) {
      mask[i] = false;
      if (ch === "*" && next === "/") {
        mask[i + 1] = false;
        block_comment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      mask[i] = false;
      if (ch === "\\") {
        mask[i + 1] = false;
        i++;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      mask[i] = false;
      mask[i + 1] = false;
      line_comment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      mask[i] = false;
      mask[i + 1] = false;
      block_comment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      mask[i] = false;
      quote = ch;
      continue;
    }
  }
  return mask;
}

type js_pattern = {
  re: RegExp;
  kind: string;
  body: "brace" | "arrow" | "class";
};

// declarations and expressions first, then arrows, then method shorthand. the
// generic <...> bits and the return type annotations are typescript only, and
// they are optional, so the same list still matches plain javascript.
const js_patterns: js_pattern[] = [
  { re: /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g, kind: "function", body: "brace" },
  { re: /\bclass\s+([A-Za-z_$][\w$]*)/g, kind: "class", body: "class" },
  {
    re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/g,
    kind: "function",
    body: "brace",
  },
  {
    re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=;]+)?=>/g,
    kind: "function",
    body: "arrow",
  },
  {
    re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/g,
    kind: "function",
    body: "arrow",
  },
  {
    re: /^[ \t]*(?:(?:public|private|protected|static|async|readonly|abstract|override|declare|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{/gm,
    kind: "method",
    body: "brace",
  },
];

// run every pattern over the whole file and resolve the body of each hit. the
// order in js_patterns matters: a named function declaration wins over the
// method regex, which is much looser.
function js_candidates(text: string): js_candidate[] {
  const out: js_candidate[] = [];
  for (const pattern of js_patterns) {
    const re = pattern.re;
    re.lastIndex = 0;
    for (;;) {
      const m = re.exec(text);
      if (!m) break;
      const name = m[1];
      if (js_reserved.has(name)) continue;

      const start = line_at(text, m.index);
      let end = -1;
      if (pattern.body === "class") {
        const open = body_brace(text, m.index + m[0].length);
        if (open < 0) continue;
        const close = match_brace(text, open);
        if (close < 0) continue;
        end = line_at(text, close);
      } else if (pattern.body === "arrow") {
        const arrow = m.index + m[0].lastIndexOf("=>");
        const body = skip_space(text, arrow + 2);
        if (text[body] === "{") {
          const close = match_brace(text, body);
          if (close < 0) continue;
          end = line_at(text, close);
        } else {
          end = line_at(text, expression_end(text, body));
        }
      } else {
        const open = body_brace(text, m.index);
        if (open < 0) continue;
        const close = match_brace(text, open);
        if (close < 0) continue;
        end = line_at(text, close);
      }

      out.push({ name, start, end, kind: pattern.kind });
    }
  }
  return out;
}

// used after an arrow, where the body may start on the next line.
function skip_space(text: string, from: number) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function body_brace(text: string, from: number): number {
  // find the opening brace without tripping over strings or parameter parens.
  // square brackets matter for go (map[string]int) and c# (attributes), where a
  // brace inside them is not the function body.
  let parens = 0;
  let brackets = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    else if (ch === "{" && parens <= 0 && brackets <= 0) return i;
    else if (ch === ";" && parens <= 0 && brackets <= 0) return -1;
  }
  return -1;
}

function expression_end(text: string, from: number): number {
  // body of a braceless arrow: ends at a top level semicolon or newline
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth <= 0 && (ch === ";" || ch === "\n")) return i;
  }
  return text.length;
}

// line numbers are zero based inside this file and one based when they leave
// it. this is the boundary.
function line_at(text: string, index: number) {
  let line = 0;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function match_brace(text: string, open: number): number {
  // skip comments and strings, or a } inside one ends the function early
  let depth = 0;
  let quote = "";
  let line_comment = false;
  let block_comment = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (line_comment) {
      if (ch === "\n") line_comment = false;
      continue;
    }
    if (block_comment) {
      if (ch === "*" && next === "/") {
        block_comment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") {
      line_comment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      block_comment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
