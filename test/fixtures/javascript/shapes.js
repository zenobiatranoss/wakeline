function shapes(n) {
  let log = [];
  if (n > 5) log.push("big");
  else if (n > 2) log.push("mid");
  for (let i = 0; i < n; i++) if (i % 2) continue; else log.push("e" + i);
  for (const k in { a: 1, b: 2 }) if (k === "b") break; else log.push(k);
  for (const v of [1, 2, 3]) log.push(v * 2);
  let m = 0;
  while (m < 3) if (m++ === 1) continue;
  switch (n) {
    case 1: log.push("one"); break;
    case 4: if (n) log.push("four"); break;
    default: log.push("def");
  }
  try { if (n > 3) throw new Error("boom"); } catch (e) { if (e) log.push(e.message); } finally { log.push("fin"); }
  a: for (;;) { b: for (;;) { if (n >= 0) break a; } }
  const f = (z) => z * 2;
  if (n) { log.push(f(n)); } else log.push("zero");
  return log.join("|") + m;
}
for (const n of [0, 1, 3, 4, 7]) console.log(shapes(n));
