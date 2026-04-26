from __future__ import annotations

from CustomerRecords import customer_discount_percent


PRODUCTS = {
    "bean-box": {"sku": "bean-box", "unit_price_cents": 2400, "tax_rate": 0.12},
    "tea-crate": {"sku": "tea-crate", "unit_price_cents": 1800, "tax_rate": 0.12},
    "gift-wrap": {"sku": "gift-wrap", "unit_price_cents": 300, "tax_rate": 0.25},
}


def price_line(customer_id: str, sku: str, quantity: int) -> dict[str, int | str]:
    if quantity <= 0:
        raise ValueError("quantity_must_be_positive")

    product = PRODUCTS.get(sku)
    if product is None:
        raise KeyError(f"unknown_sku:{sku}")

    subtotal = int(product["unit_price_cents"]) * quantity
    discount_percent = customer_discount_percent(customer_id)
    discount_cents = subtotal * discount_percent // 100
    taxed_base = subtotal - discount_cents
    tax_cents = round(taxed_base * float(product["tax_rate"]))

    return {
        "sku": sku,
        "quantity": quantity,
        "subtotal_cents": subtotal,
        "discount_cents": discount_cents,
        "tax_cents": int(tax_cents),
        "total_cents": taxed_base + int(tax_cents),
    }
