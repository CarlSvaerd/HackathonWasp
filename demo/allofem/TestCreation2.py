from __future__ import annotations

from TestCreation1 import CartItem, Inventory


def calculate_subtotal(items: list[CartItem], inventory: Inventory) -> int:
    subtotal = 0
    for item in items:
        product = inventory.get_product(item.sku)
        subtotal += product.price_cents * item.quantity
    return subtotal


def calculate_shipping(items: list[CartItem], inventory: Inventory) -> int:
    if not items:
        return 0

    shipping = 499
    fragile_items = 0
    for item in items:
        product = inventory.get_product(item.sku)
        if product.fragile:
            fragile_items += item.quantity

    shipping += fragile_items * 150
    return shipping


def calculate_discount(subtotal_cents: int, coupon_code: str | None) -> int:
    normalized_coupon = (coupon_code or "").strip().upper()
    if subtotal_cents <= 0:
        return 0
    if normalized_coupon == "SAVE10":
        return subtotal_cents // 10
    if normalized_coupon == "BULK15" and subtotal_cents >= 5000:
        return subtotal_cents * 15 // 100
    return 0


def calculate_total(items: list[CartItem], inventory: Inventory, coupon_code: str | None = None) -> dict[str, int]:
    subtotal = calculate_subtotal(items, inventory)
    shipping = calculate_shipping(items, inventory)
    discount = calculate_discount(subtotal, coupon_code)
    total = max(0, subtotal + shipping - discount)
    return {
        "subtotal_cents": subtotal,
        "shipping_cents": shipping,
        "discount_cents": discount,
        "total_cents": total,
    }
