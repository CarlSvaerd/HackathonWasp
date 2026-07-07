from __future__ import annotations

from CatalogPricing import price_line


class InvoiceLedger:
    def __init__(self) -> None:
        self._invoices: list[dict[str, object]] = []

    def create_invoice(self, customer_id: str, requested_lines: list[dict[str, object]]) -> dict[str, object]:
        if not requested_lines:
            raise ValueError("invoice_requires_lines")

        lines = []
        grand_total_cents = 0
        for requested_line in requested_lines:
            sku = str(requested_line["sku"])
            quantity = int(requested_line["quantity"])
            line = price_line(customer_id, sku, quantity)
            lines.append(line)
            grand_total_cents += int(line["total_cents"])

        invoice = {
            "invoice_id": f"inv-{len(self._invoices) + 1:03d}",
            "customer_id": customer_id,
            "line_count": len(lines),
            "grand_total_cents": grand_total_cents,
            "status": "draft",
            "lines": lines,
        }
        self._invoices.append(invoice)
        return invoice

    def mark_sent(self, invoice_id: str) -> dict[str, object]:
        invoice = self.get_invoice(invoice_id)
        invoice["status"] = "sent"
        return invoice

    def get_invoice(self, invoice_id: str) -> dict[str, object]:
        for invoice in self._invoices:
            if invoice["invoice_id"] == invoice_id:
                return invoice
        raise KeyError(f"unknown_invoice:{invoice_id}")
