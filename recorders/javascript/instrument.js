const acorn = require("acorn");

// rewrites javascript source so one chosen function reports what it is doing.
// the approach is source-level, not a debugger: parse with acorn, find the
// target function, and splice in calls to a small runtime. the rest of the file
// is untouched, and if anything looks wrong the caller falls back to running
// the original source.

const helper = "globalThis.__wakeline_wk";

function instrument(source, opts) {
  // two walks. the first records parent links and every function, because a
  // function's name depends on what contains it. the second instruments only
  // the chosen one.
  const ast = parse_source(source);
  const parents = new WeakMap();
  const functions = [];
  walk(ast, null, (node, parent) => {
    parents.set(node, parent);
    if (is_function(node)) functions.push(node);
  });

  const target = pick_target(functions, parents, opts);
  if (!target) throw new Error(`function not found near line ${opts.line0}`);

  // the injected names must not collide with anything already in the function.
  // collected from the target subtree so nested code counts too.
  const used = new Set();
  walk(target, null, (node) => {
    if (node.type === "Identifier" && node.name) used.add(node.name);
  });
  const token = choose_name(used, "__wk_call");
  const err_name = choose_name(used, "__wk_err");
  const ctx = {
    source,
    parents,
    token,
    err_name,
    prefixes: new Map(),
    replacements: [],
    target,
    name: qualified_name(target, parents) || opts.name || "",
  };

  instrument_function(target, ctx);
  return apply_edits(source, ctx);
}

function parse_source(source) {
  // try script first because that's what a plain .js file is. module syntax
  // makes acorn reject script mode, so fall back to module and report the
  // module error if both fail.
  const base = {
    ecmaVersion: "latest",
    locations: true,
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
  };
  try {
    return acorn.parse(source, { ...base, sourceType: "script" });
  } catch (first) {
    try {
      return acorn.parse(source, { ...base, sourceType: "module" });
    } catch (second) {
      throw new Error(`cannot parse javascript: ${second.message}`);
    }
  }
}

function is_function(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function walk(node, parent, visit) {
  // a generic ast walker. acorn nodes are plain objects, so every child is
  // either a node or an array of them. skip the location and offset fields.
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, node, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, node, visit);
    }
  }
}

function pick_target(functions, parents, opts) {
  // best case: the line range matches exactly. after that, accept anything
  // covering the start line with a compatible name, then anything covering it.
  // the smallest such function wins, which handles nesting.
  const l0 = Number(opts.line0) || 0;
  const l1 = Number(opts.line1) || 0;
  let hits = functions.filter((node) => node.loc.start.line === l0 && node.loc.end.line === l1);
  if (!hits.length) {
    hits = functions.filter((node) => {
      const name = function_name(node, parents);
      const same = !opts.name || !name || opts.name === name || opts.name.endsWith("." + name) || name.endsWith("." + opts.name);
      return same && node.loc.start.line <= l0 && node.loc.end.line >= l0;
    });
  }
  if (!hits.length) {
    hits = functions.filter((node) => node.loc.start.line <= l0 && node.loc.end.line >= l0);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => span(a) - span(b));
  return hits[0];
}

function span(node) {
  return node.end - node.start;
}

function function_name(node, parents) {
  // a function has no name of its own in half the ways it can be written, so
  // look at what it is assigned to or stored under.
  if (node.id && node.id.type === "Identifier") return node.id.name;
  const parent = parents.get(node);
  if (!parent) return "";
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if (parent.type === "AssignmentExpression") return target_name(parent.left);
  if (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") {
    if (!parent.computed) return target_name(parent.key);
  }
  if (parent.type === "ExportDefaultDeclaration") return "default";
  return "";
}

function target_name(node) {
  // the display name for the thing on the left of an assignment, which may be
  // an identifier, a private name or a member expression like a.b.
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateIdentifier") return "#" + node.name;
  if (node.type === "MemberExpression" && !node.computed) return target_name(node.property);
  return "";
}

function qualified_name(node, parents) {
  // walk outwards adding prefixes until we hit a class or the module top. this
  // is what turns total into cart.total, matching the python side.
  let name = function_name(node, parents) || "anonymous";
  let parent = parents.get(node);
  while (parent) {
    if (parent.type === "ClassDeclaration" || parent.type === "ClassExpression") {
      if (parent.id && parent.id.name) name = parent.id.name + "." + name;
      break;
    }
    if (parent.type === "MethodDefinition" || parent.type === "Property" || parent.type === "PropertyDefinition") {
      const key = parent.computed ? "" : target_name(parent.key);
      if (key && key !== name) name = key + "." + name;
    } else if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier" && parent.id.name !== name) {
      name = parent.id.name + "." + name;
      break;
    } else if (is_function(parent)) {
      const outer = function_name(parent, parents);
      if (outer && outer !== name) name = outer + "." + name;
      break;
    }
    parent = parents.get(parent);
  }
  return name;
}

function instrument_function(node, ctx) {
  // a normal braced function gets a try/finally wrapped around its body. the
  // finally is what guarantees a call_end even when the body throws.
  const params = [];
  for (const param of node.params) params.push(...pattern_names(param));

  if (node.body.type !== "BlockStatement") {
    instrument_expression_body(node, params, ctx);
    return;
  }

  const body = node.body;
  const var_names = [];
  scan_vars(body, body, var_names);
  const scope = make_scope(null, body, [...params, ...var_names]);
  const args = object_literal(params);
  // the entered state is a const inside the function, so nested calls of the
  // same function each have their own. instrumented code never reads it.
  const entry = `const ${ctx.token}=${helper}.enter(${JSON.stringify(ctx.name)},${node.loc.start.line},${node.loc.end.line},${args});try{`;
  const leave = `}catch(${ctx.err_name}){${helper}.err(${ctx.token},${ctx.err_name});throw ${ctx.err_name};}finally{${helper}.end(${ctx.token});}`;
  // after any "use strict" directives, not before, or they stop being directives.
  const start = entry_offset(body);

  ctx.prefixes.set(start, entry);
  ctx.prefixes.set(body.end - 1, leave);
  instrument_block(body, scope, ctx);
}

function instrument_expression_body(node, params, ctx) {
  // an arrow with no braces is a single expression. turn it into a block with
  // an explicit return so there is somewhere to put the try/finally.
  const body = node.body;
  const inner = ctx.source.slice(body.start, body.end);
  const args = object_literal(params);
  const tick = make_tick(ctx, body.start, new Set(params), body.loc.start.line);
  const text =
    `{const ${ctx.token}=${helper}.enter(${JSON.stringify(ctx.name)},${node.loc.start.line},${node.loc.end.line},${args});try{` +
    `${tick}return ${helper}.ret(${ctx.token},(${inner}));` +
    `}catch(${ctx.err_name}){${helper}.err(${ctx.token},${ctx.err_name});throw ${ctx.err_name};}finally{${helper}.end(${ctx.token});}}`;
  ctx.replacements.push({ start: body.start, end: body.end, text });
}

function entry_offset(body) {
  // skip past directives like "use strict" so they still take effect.
  let offset = body.start + 1;
  for (const stmt of body.body) {
    if (stmt.directive) offset = stmt.end;
    else break;
  }
  return offset;
}

function make_scope(parent, block, extra) {
  // a tiny model of which names exist at a point. enough to know what can be
  // captured in a tick without worrying about real lexical analysis.
  const scope = { parent, lexical: [], hoisted: new Set(extra || []) };
  if (block) {
    for (const stmt of block.body) {
      if (stmt.type === "VariableDeclaration" && stmt.kind !== "var") {
        for (const decl of stmt.declarations) {
          for (const name of pattern_names(decl.id)) scope.lexical.push({ name, start: stmt.start });
        }
      } else if (stmt.type === "FunctionDeclaration" && stmt.id) {
        scope.hoisted.add(stmt.id.name);
      } else if (stmt.type === "ClassDeclaration" && stmt.id) {
        scope.lexical.push({ name: stmt.id.name, start: stmt.start });
      }
    }
  }
  return scope;
}

function visible(scope, at) {
  // names declared before `at` are usable; a later declaration shadows an
  // outer one of the same name for the whole block, which is why blocked exists.
  const names = [];
  const blocked = new Set();
  for (let s = scope; s; s = s.parent) {
    for (const decl of s.lexical) {
      if (decl.start < at) {
        if (!blocked.has(decl.name)) {
          names.push(decl.name);
          blocked.add(decl.name);
        }
      } else {
        blocked.add(decl.name);
      }
    }
    for (const name of s.hoisted) {
      if (!blocked.has(name)) {
        names.push(name);
        blocked.add(name);
      }
    }
  }
  return names;
}

function instrument_block(block, scope, ctx) {
  for (const stmt of block.body) instrument_statement(stmt, scope, ctx);
}

function instrument_statement(stmt, scope, ctx) {
  // the interesting statements get a tick before they run and their bodies are
  // walked separately. plain statements just get a tick and are left alone.
  if (stmt.directive) return;

  switch (stmt.type) {
    case "EmptyStatement":
      return;
    case "BlockStatement":
      instrument_block(stmt, make_scope(scope, stmt), ctx);
      return;
    case "ReturnStatement": {
      // capture the values before the expression runs, then pass the result
      // through ret() so the call_end line can include it.
      const tick = make_tick(ctx, stmt.start, visible(scope, stmt.start), stmt.loc.start.line);
      const expr = stmt.argument ? ctx.source.slice(stmt.argument.start, stmt.argument.end) : "undefined";
      ctx.replacements.push({
        start: stmt.start,
        end: stmt.end,
        text: `${tick}return ${helper}.ret(${ctx.token},(${expr}));`,
      });
      return;
    }
    case "ThrowStatement": {
      // thrown() records the exception and returns it unchanged, so the actual
      // throw still behaves exactly as written.
      const tick = make_tick(ctx, stmt.start, visible(scope, stmt.start), stmt.loc.start.line);
      const expr = ctx.source.slice(stmt.argument.start, stmt.argument.end);
      ctx.replacements.push({
        start: stmt.start,
        end: stmt.end,
        text: `${tick}throw ${helper}.thrown(${ctx.token},(${expr}));`,
      });
      return;
    }
    case "FunctionDeclaration":
      add_prefix(ctx, stmt.start, make_tick(ctx, stmt.start, visible(scope, stmt.start), stmt.loc.start.line));
      return;
    case "ClassDeclaration":
      add_prefix(ctx, stmt.start, make_tick(ctx, stmt.start, visible(scope, stmt.start), stmt.loc.start.line));
      return;
    case "IfStatement":
      add_tick(stmt, scope, ctx);
      instrument_statement(stmt.consequent, scope, ctx);
      if (stmt.alternate) instrument_statement(stmt.alternate, scope, ctx);
      return;
    case "ForStatement": {
      // the loop head gets a tick, and the body gets a second one so each
      // iteration shows up even when the body spans several lines.
      add_tick(stmt, scope, ctx);
      const loop = loop_scope(scope, stmt.init ? declaration_names(stmt.init) : []);
      add_body_tick(stmt.body, loop, ctx, stmt.loc.start.line);
      instrument_statement(stmt.body, loop, ctx);
      return;
    }
    case "ForInStatement":
    case "ForOfStatement": {
      add_tick(stmt, scope, ctx);
      const loop = loop_scope(scope, declaration_names(stmt.left));
      add_body_tick(stmt.body, loop, ctx, stmt.loc.start.line);
      instrument_statement(stmt.body, loop, ctx);
      return;
    }
    case "WhileStatement":
    case "DoWhileStatement":
      add_tick(stmt, scope, ctx);
      add_body_tick(stmt.body, scope, ctx, stmt.loc.start.line);
      instrument_statement(stmt.body, scope, ctx);
      return;
    case "SwitchStatement": {
      // case bodies share one scope, so collect them into a fake block and
      // walk that. let declarations in a switch are weird but legal.
      add_tick(stmt, scope, ctx);
      const flat = [];
      for (const item of stmt.cases) flat.push(...item.consequent);
      const switch_scope = make_scope(scope, { body: flat }, []);
      for (const item of stmt.cases) {
        for (const inner of item.consequent) instrument_statement(inner, switch_scope, ctx);
      }
      return;
    }
    case "TryStatement":
      // the catch parameter only exists inside the handler, hence its own scope.
      add_tick(stmt, scope, ctx);
      instrument_statement(stmt.block, scope, ctx);
      if (stmt.handler) {
        const names = stmt.handler.param ? pattern_names(stmt.handler.param) : [];
        const catch_scope = loop_scope(scope, names);
        instrument_statement(stmt.handler.body, catch_scope, ctx);
      }
      if (stmt.finalizer) instrument_statement(stmt.finalizer, scope, ctx);
      return;
    case "LabeledStatement":
      add_tick(stmt, scope, ctx);
      instrument_statement(stmt.body, scope, ctx);
      return;
    case "WithStatement":
      add_tick(stmt, scope, ctx);
      instrument_statement(stmt.body, scope, ctx);
      return;
    default:
      add_tick(stmt, scope, ctx);
  }
}

function add_tick(stmt, scope, ctx) {
  add_prefix(ctx, stmt.start, make_tick(ctx, stmt.start, visible(scope, stmt.start), stmt.loc.start.line));
}

function add_body_tick(body, scope, ctx, line) {
  // for a braced body, insert just inside the brace so the tick runs at the top
  // of every iteration. for a single-statement body, prefix that statement.
  const at = body.type === "BlockStatement" ? entry_offset(body) : body.start;
  add_prefix(ctx, at, make_tick(ctx, at, visible(scope, at), line));
}

function add_prefix(ctx, offset, text) {
  ctx.prefixes.set(offset, (ctx.prefixes.get(offset) || "") + text);
}

function loop_scope(parent, names) {
  return { parent, lexical: [], hoisted: new Set(names) };
}

function make_tick(ctx, at, names, line) {
  // no visible names means nothing to capture, so skip building a closure.
  // otherwise each name is read in its own try: a getter on a proxy can throw,
  // and that must not break the user's function.
  if (!names.length) return `${helper}.at(${ctx.token},${line},null);`;
  let body = "var v=Object.create(null);";
  for (const name of names) {
    body += `try{v[${JSON.stringify(name)}]=${name};}catch(e){}`;
  }
  return `${helper}.at(${ctx.token},${line},()=>{${body}return v;});`;
}

function object_literal(names) {
  // used for the arguments map at call_start. duplicates can appear with
  // destructuring, so keep the first one.
  const parts = [];
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    parts.push(`${JSON.stringify(name)}:${name}`);
  }
  return `{${parts.join(",")}}`;
}

function pattern_names(node) {
  // pull every identifier out of a binding pattern: plain names, destructured
  // objects, arrays, defaults and rest all reduce to a list of names.
  if (!node) return [];
  switch (node.type) {
    case "Identifier":
      return [node.name];
    case "ObjectPattern":
      return node.properties.flatMap((prop) => {
        if (prop.type === "RestElement") return pattern_names(prop.argument);
        return pattern_names(prop.value);
      });
    case "ArrayPattern":
      return node.elements.flatMap((item) => pattern_names(item));
    case "AssignmentPattern":
      return pattern_names(node.left);
    case "RestElement":
      return pattern_names(node.argument);
    default:
      return [];
  }
}

function declaration_names(node) {
  if (!node) return [];
  if (node.type === "VariableDeclaration") {
    return node.declarations.flatMap((decl) => pattern_names(decl.id));
  }
  return pattern_names(node);
}

function scan_vars(node, root, out) {
  // var declarations are hoisted to the function, so they are visible from the
  // first line even if they are written much later. collect them separately.
  if (node !== root && is_function(node)) return;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const decl of node.declarations) out.push(...pattern_names(decl.id));
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === "string") scan_vars(child, root, out);
    } else if (value && typeof value.type === "string") {
      scan_vars(value, root, out);
    }
  }
}

function choose_name(used, base) {
  // keep appending underscores until the name is free. ugly but the chance of a
  // collision chain long enough to matter is nil.
  let name = base;
  while (used.has(name)) name += "_";
  used.add(name);
  return name;
}

function apply_edits(source, ctx) {
  // edits are applied from the end backwards so earlier offsets stay valid.
  // a replacement can also have a prefix queued at the same offset, which is
  // how a return statement gets its tick first and its rewrite second.
  const edits = [];
  for (const replacement of ctx.replacements) {
    let text = replacement.text;
    const prefix = ctx.prefixes.get(replacement.start);
    if (prefix) {
      text = prefix + text;
      ctx.prefixes.delete(replacement.start);
    }
    edits.push({ start: replacement.start, end: replacement.end, text });
  }
  for (const [start, text] of ctx.prefixes) edits.push({ start, end: start, text });
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

module.exports = { instrument, pick_target, qualified_name, function_name };
