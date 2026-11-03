"""Symbol table. The engine uses integer ids, the API and database use ticker strings.

Start prices (in cents) are made-up reference prices for the simulation. They are only
used until the first real trade of a symbol; after that the last trade price is used.
"""

SYMBOLS: list[tuple[int, str, int]] = [
    # (symbol_id, ticker, start price in cents)
    (1, "AAPL", 18950),
    (2, "TSLA", 24000),
    (3, "NVDA", 12000),
    (4, "MSFT", 41000),
    (5, "AMZN", 18500),
    (6, "GOOGL", 17000),
    (7, "META", 50000),
    (8, "JPM", 20000),
    (9, "BRK-B", 45000),
    (10, "AMD", 15000),
]

SYMBOL_BY_ID: dict[int, str] = {sid: name for sid, name, _ in SYMBOLS}
SYMBOL_IDS: dict[str, int] = {name: sid for sid, name, _ in SYMBOLS}
START_PRICES: dict[str, int] = {name: price for _, name, price in SYMBOLS}
ALL_SYMBOLS: list[str] = [name for _, name, _ in SYMBOLS]
DEFAULT_SYMBOL = "AAPL"
