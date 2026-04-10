"""
Script de backfill : indexe les blocs historiques en parallèle.
Usage : python scripts/backfill/run.py --from 1000000 --to 2000000 --workers 20
"""

import asyncio
import argparse
import logging
from typing import AsyncIterator

from web3 import AsyncWeb3
from web3.providers import AsyncHTTPProvider

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

CHUNK_SIZE = 1000  # blocs par chunk


def chunk_range(start: int, end: int, size: int):
    for i in range(start, end + 1, size):
        yield (i, min(i + size - 1, end))


async def process_chunk(
    w3: AsyncWeb3,
    from_block: int,
    to_block: int,
    sem: asyncio.Semaphore
):
    async with sem:
        try:
            logs = await w3.eth.get_logs({
                "fromBlock": from_block,
                "toBlock":   to_block,
                "topics": [[
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31",
                ]]
            })
            logger.info(f"Blocks {from_block}-{to_block}: {len(logs)} logs")
            # TODO: décoder et publier sur Kafka
        except Exception as e:
            logger.error(f"Chunk {from_block}-{to_block} failed: {e}")


async def main(from_block: int, to_block: int, workers: int):
    w3  = AsyncWeb3(AsyncHTTPProvider(
        "https://rpc.abstract.network",
        request_kwargs={"timeout": 30}
    ))
    sem = asyncio.Semaphore(workers)

    chunks = list(chunk_range(from_block, to_block, CHUNK_SIZE))
    logger.info(f"Backfilling {len(chunks)} chunks ({workers} parallel workers)")

    await asyncio.gather(*[
        process_chunk(w3, start, end, sem)
        for start, end in chunks
    ])
    logger.info("Backfill complete")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--from",    dest="from_block", type=int, required=True)
    parser.add_argument("--to",      dest="to_block",   type=int, required=True)
    parser.add_argument("--workers", type=int, default=20)
    args = parser.parse_args()

    asyncio.run(main(args.from_block, args.to_block, args.workers))
