import asyncio


async def work(n):
    await asyncio.sleep(0)
    return n * 2


if __name__ == "__main__":
    print(asyncio.run(work(3)))
