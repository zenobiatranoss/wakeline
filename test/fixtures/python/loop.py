def classify(n):
    total = 0
    for i in range(n):
        if i % 2 == 0:
            total += i
        else:
            total -= i
    return total


if __name__ == "__main__":
    print(classify(6))
