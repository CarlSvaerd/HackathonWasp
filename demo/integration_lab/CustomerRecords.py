from __future__ import annotations


CUSTOMERS = {
    "c-100": {
        "customer_id": "c-100",
        "name": "River Foods",
        "email": "ops@riverfoods.example",
        "tier": "gold",
        "credit_limit_cents": 150000,
    },
    "c-200": {
        "customer_id": "c-200",
        "name": "Northwind Studio",
        "email": "finance@northwind.example",
        "tier": "standard",
        "credit_limit_cents": 50000,
    },
}


def get_customer(customer_id: str) -> dict[str, object]:
    normalized_id = customer_id.strip().lower()
    customer = CUSTOMERS.get(normalized_id)
    if customer is None:
        raise KeyError(f"unknown_customer:{normalized_id}")
    return dict(customer)


def customer_discount_percent(customer_id: str) -> int:
    customer = get_customer(customer_id)
    if customer["tier"] == "gold":
        return 15
    if customer["tier"] == "standard":
        return 5
    return 0
