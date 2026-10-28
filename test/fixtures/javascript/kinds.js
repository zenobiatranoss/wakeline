const twice = function (n) {
  return n * 2;
};

const square = (n) => n * n;

class counter {
  constructor(start) {
    this.value = start;
  }

  add(n) {
    this.value += n;
    return this.value;
  }

  static make(n) {
    return new counter(n);
  }
}

function outer(n) {
  const inner = (x) => x + n;
  return inner(2);
}

function fact(n) {
  if (n <= 1) {
    return 1;
  }
  return n * fact(n - 1);
}

async function wait(n) {
  const value = await Promise.resolve(n + 1);
  return value;
}

function* count(n) {
  for (let i = 0; i < n; i++) {
    yield i;
  }
}

console.log(twice(3), square(4), counter.make(1).add(2), outer(5), fact(3));
wait(2).then((v) => console.log(v));
console.log([...count(3)]);
