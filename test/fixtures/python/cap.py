def spin(n):
    total = 0
    for i in range(n):
        total += i
    return total


def call_many(n):
    total = 0
    for i in range(n):
        total += spin(3)
    return total


if __name__ == "__main__":
    print(spin(1000))
    print(call_many(30))
