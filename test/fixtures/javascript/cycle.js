function cycle() {
  const a = [];
  a.push(a);
  const b = { a };
  return a;
}

cycle();
