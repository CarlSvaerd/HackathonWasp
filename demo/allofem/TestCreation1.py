from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price_cents: int
    available_units: int
    fragile: bool = False


@dataclass(frozen=True)
class CartItem:
    sku: str
    quantity: int


class Inventory:
    def __init__(self) -> None:
        self._products = {
            "NOTE-01": Product("NOTE-01", "Notebook", 1299, 15, fragile=False),
            "MUG-02": Product("MUG-02", "Coffee Mug", 1799, 8, fragile=True),
            "PEN-03": Product("PEN-03", "Blue Pen", 299, 40, fragile=False),
        }

    def get_product(self, sku: str) -> Product:
        normalized_sku = normalize_sku(sku)
        product = self._products.get(normalized_sku)
        if product is None:
            raise KeyError(f"unknown_sku:{normalized_sku}")
        return product

    def has_enough_stock(self, sku: str, quantity: int) -> bool:
        if quantity <= 0:
            return False
        product = self.get_product(sku)
        return product.available_units >= quantity

    def reserve(self, sku: str, quantity: int) -> Product:
        if quantity <= 0:
            raise ValueError("quantity_must_be_positive")

        product = self.get_product(sku)
        if product.available_units < quantity:
            raise ValueError("not_enough_stock")

        updated_product = Product(
            sku=product.sku,
            name=product.name,
            price_cents=product.price_cents,
            available_units=product.available_units - quantity,
            fragile=product.fragile,
        )
        self._products[product.sku] = updated_product
        return updated_product


def normalize_sku(raw_sku: str) -> str:
    return raw_sku.strip().upper()
