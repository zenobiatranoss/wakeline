def count(n):
    for i in range(n):
        yield i


if __name__ == "__main__":
    print(list(count(4)))
