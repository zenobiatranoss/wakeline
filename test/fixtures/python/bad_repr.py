class broken:
    def __repr__(self):
        raise RuntimeError("no repr for you")


def take(x):
    return 1


if __name__ == "__main__":
    print(take(broken()))
