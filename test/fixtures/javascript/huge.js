function size(xs) {
  return xs.length;
}

size(Array.from({ length: 100000 }, (_, i) => i));
