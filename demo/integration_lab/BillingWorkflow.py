from __future__ import annotations

from CustomerRecords import get_customer
from InvoiceLedger import InvoiceLedger


class BillingWorkflow:
    def __init__(self, ledger: InvoiceLedger | None = None) -> None:
        self.ledger = ledger or InvoiceLedger()

    def preview_invoice(self, customer_id: str, requested_lines: list[dict[str, object]]) -> dict[str, object]:
        customer = get_customer(customer_id)
        invoice = self.ledger.create_invoice(customer_id, requested_lines)
        return {
            "customer_email": customer["email"],
            "invoice_id": invoice["invoice_id"],
            "line_count": invoice["line_count"],
            "grand_total_cents": invoice["grand_total_cents"],
            "status": invoice["status"],
        }

    def finalize_invoice(self, customer_id: str, requested_lines: list[dict[str, object]]) -> dict[str, object]:
        preview = self.preview_invoice(customer_id, requested_lines)
        invoice = self.ledger.mark_sent(str(preview["invoice_id"]))
        return {
            "invoice_id": invoice["invoice_id"],
            "customer_id": customer_id,
            "status": invoice["status"],
            "charged_cents": invoice["grand_total_cents"],
            "line_count": invoice["line_count"],
        }
