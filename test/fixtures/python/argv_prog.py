import sys


def show(a, b):
    return a + b


if __name__ == "__main__":
    print(show(int(sys.argv[1]), int(sys.argv[2])))
