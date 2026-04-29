FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd -m -u 1001 indexer && chown -R indexer:indexer /app
USER indexer

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD python -c "import asyncio, asyncpg, os; asyncio.run(asyncpg.connect(os.environ['DATABASE_URL']))" || exit 1

CMD ["python", "main.py"]
