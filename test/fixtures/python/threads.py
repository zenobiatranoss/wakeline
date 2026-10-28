import threading


def work(n):
    return n * 2


if __name__ == "__main__":
    out = []

    def run(i):
        out.append(work(i))

    threads = [threading.Thread(target=run, args=(i,)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    print(sorted(out))
