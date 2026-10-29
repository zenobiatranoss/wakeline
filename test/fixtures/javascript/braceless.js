function classify(x) {
  if (x < 0) return "neg";
  if (x === 0) return "zero";
  return "pos";
}

function chain(x) {
  const out = [];
  if (x === 1) out.push("one");
  else if (x === 2) out.push("two");
  else out.push("other");
  for (let i = 0; i < 3; i++) out.push(i);
  let n = 0;
  while (n < 2) n++;
  do n--; while (n > 0);
  return out.join(",") + n;
}

function nested(a, b) {
  if (a) if (b) return "ab"; else return "a";
  return "none";
}

function labeled(grid) {
  let hits = 0;
  outer: for (const row of grid) {
    for (const cell of row) {
      if (cell < 0) continue outer;
      if (cell > 8) break outer;
      hits += cell;
    }
  }
  return hits;
}

console.log(classify(-5), classify(0), classify(7));
console.log(chain(1), chain(2), chain(9));
console.log(nested(1, 1), nested(1, 0), nested(0, 1));
console.log(labeled([[1, 2], [-1, 5], [3, 9], [4]]));
