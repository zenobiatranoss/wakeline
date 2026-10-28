function spin(n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += i;
  }
  return total;
}

for (let i = 0; i < 4; i++) {
  spin(3);
}
