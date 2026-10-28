const tricky = {
  ok: 1,
  get bad() {
    throw new Error("nope");
  },
};

function take(value) {
  return value.ok;
}

take(tricky);
