from __future__ import annotations

from TestCreation1 import CartItem, Inventory
from TestCreation2 import calculate_total


class CheckoutService:
    def __init__(self, inventory: Inventory | None = None) -> None:
        self.inventory = inventory or Inventory()

    def preview_order(self, raw_items: list[dict[str, int | str]], coupon_code: str | None = None) -> dict[str, object]:
        items = self._parse_items(raw_items)
        self._validate_stock(items)
        pricing = calculate_total(items, self.inventory, coupon_code)
        return {
            "items": [{"sku": item.sku, "quantity": item.quantity} for item in items],
            "pricing": pricing,
            "is_empty": len(items) == 0,
        }

    def place_order(self, raw_items: list[dict[str, int | str]], coupon_code: str | None = None) -> dict[str, object]:
        preview = self.preview_order(raw_items, coupon_code)
        parsed_items = self._parse_items(raw_items)

        for item in parsed_items:
            self.inventory.reserve(item.sku, item.quantity)

        pricing = preview["pricing"]
        assert isinstance(pricing, dict)
        return {
            "status": "confirmed",
            "line_count": len(parsed_items),
            "charged_cents": pricing["total_cents"],
        }

    def _parse_items(self, raw_items: list[dict[str, int | str]]) -> list[CartItem]:
        parsed_items: list[CartItem] = []
        for raw_item in raw_items:
            sku = str(raw_item.get("sku", ""))
            quantity = int(raw_item.get("quantity", 0))
            if not sku:
                raise ValueError("missing_sku")
            if quantity <= 0:
                raise ValueError("invalid_quantity")
            parsed_items.append(CartItem(sku=sku, quantity=quantity))
        return parsed_items

    def _validate_stock(self, items: list[CartItem]) -> None:
        for item in items:
            if not self.inventory.has_enough_stock(item.sku, item.quantity):
                raise ValueError(f"stock_check_failed:{item.sku}")
