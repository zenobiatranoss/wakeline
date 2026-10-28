def divide(a, b):
    return a / b


if __name__ == "__main__":
    try:
        divide(1, 0)
    except ZeroDivisionError:
        print("caught")
