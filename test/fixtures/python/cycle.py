def cycle():
    a = []
    a.append(a)
    b = {"a": a}
    return a


if __name__ == "__main__":
    cycle()
