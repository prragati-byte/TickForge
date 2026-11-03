# Symbol ID ↔ symbol string mapping.
# The C++ matching engine uses integer symbol_ids; the exchange API and
# frontend use ticker strings. We maintain a 10-symbol table here.

SYMBOL_MAP: dict[int, str] = {
    1:  "AAPL",
    2:  "TSLA",
    3:  "NVDA",
    4:  "MSFT",
    5:  "AMZN",
    6:  "GOOGL",
    7:  "META",
    8:  "JPM",
    9:  "BRK-B",
    10: "AMD",
}

SYMBOL_IDS: dict[str, int] = {v: k for k, v in SYMBOL_MAP.items()}

ALL_SYMBOLS = list(SYMBOL_MAP.values())
