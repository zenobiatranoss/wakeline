function divide(a, b) {
  if (b === 0) {
    throw new Error("no zero");
  }
  return a / b;
}

try {
  divide(1, 0);
} catch (err) {
  console.log("caught", err.message);
}
