from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "packages" / "vscode-extension" / "media"
SIZE = (1280, 720)

COLORS = {
    "bg": "#0f172a",
    "panel": "#111827",
    "panel_2": "#1f2937",
    "panel_3": "#0b1220",
    "border": "#334155",
    "text": "#f8fafc",
    "muted": "#94a3b8",
    "blue": "#60a5fa",
    "green": "#34d399",
    "amber": "#f59e0b",
    "red": "#f87171",
    "purple": "#a78bfa",
    "line": "#263244",
}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


FONTS = {
    "title": font(42, True),
    "h1": font(32, True),
    "h2": font(24, True),
    "body": font(19),
    "body_bold": font(19, True),
    "small": font(15),
    "small_bold": font(15, True),
    "code": font(17),
    "code_small": font(14),
}


def text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, fill: str = "text", style: str = "body") -> None:
    draw.text(xy, value, font=FONTS[style], fill=COLORS.get(fill, fill))


def box(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int, int, int],
    fill: str = "panel",
    outline: str = "border",
    radius: int = 12,
    width: int = 1,
) -> None:
    draw.rounded_rectangle(xy, radius=radius, fill=COLORS[fill], outline=COLORS[outline], width=width)


def tag(draw: ImageDraw.ImageDraw, xy: tuple[int, int], label: str, color: str) -> int:
    x, y = xy
    padding_x = 12
    padding_y = 6
    bbox = draw.textbbox((0, 0), label, font=FONTS["small_bold"])
    w = bbox[2] - bbox[0] + padding_x * 2
    h = bbox[3] - bbox[1] + padding_y * 2
    draw.rounded_rectangle((x, y, x + w, y + h), radius=8, fill=COLORS[color])
    draw.text((x + padding_x, y + padding_y - 1), label, font=FONTS["small_bold"], fill="#07111f")
    return w


def window(title: str) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", SIZE, COLORS["bg"])
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, SIZE[0], 56), fill="#020617")
    for i, color in enumerate(["#ef4444", "#f59e0b", "#22c55e"]):
        draw.ellipse((24 + i * 28, 20, 38 + i * 28, 34), fill=color)
    text(draw, (118, 15), title, "muted", "small_bold")
    return img, draw


def sidebar(draw: ImageDraw.ImageDraw, active: str) -> None:
    draw.rectangle((0, 56, 82, 720), fill="#050b17")
    items = [("files", "F"), ("testing", "T"), ("problems", "!"), ("ghost", "G")]
    y = 92
    for item, label in items:
        fill = COLORS["blue"] if item == active else COLORS["muted"]
        draw.rounded_rectangle((21, y, 61, y + 40), radius=10, fill="#111827" if item == active else "#050b17")
        draw.text((34, y + 9), label, font=FONTS["small_bold"], fill=fill)
        y += 58


def draw_report() -> None:
    img, draw = window("Ghost Test Catcher - Report")
    sidebar(draw, "ghost")
    draw.rectangle((82, 56, 1280, 720), fill=COLORS["panel_3"])

    text(draw, (116, 92), "Ghost Test Catcher", "text", "title")
    text(draw, (116, 146), "Evidence-grounded review for AI-generated Python tests", "muted", "body")
    tag(draw, (858, 98), "2 reliable", "green")
    tag(draw, (970, 98), "1 needs review", "amber")
    tag(draw, (1124, 98), "1 ghost risk", "red")

    box(draw, (116, 184, 1210, 234), "panel", "border", 10)
    text(draw, (138, 199), "Cost and cache: 0 LLM calls, ~0 input tokens, fresh analysis", "green", "body_bold")
    text(draw, (710, 202), "Existing-test review stays local by default.", "muted", "small")

    toolbar = (116, 258, 1210, 320)
    box(draw, toolbar, "panel", "border", 10)
    for i, label in enumerate(["Verdict: all", "Framework: pytest", "Evidence: auth_service", "Missing symbols", "Failed or risky"]):
        x = 138 + i * 208
        draw.rounded_rectangle((x, 275, x + 180, 302), radius=6, fill="#0f172a", outline=COLORS["border"])
        text(draw, (x + 10, 280), label, "muted", "small")

    metrics = [
        ("Reliability", "82.0%", "green"),
        ("ETV", "75.0%", "blue"),
        ("LLM calls", "0", "green"),
        ("Cache", "fresh", "blue"),
    ]
    for i, (label, value, color) in enumerate(metrics):
        x = 116 + i * 277
        box(draw, (x, 344, x + 250, 436), "panel", "border", 10)
        text(draw, (x + 18, 366), label, "muted", "small_bold")
        text(draw, (x + 18, 392), value, color, "h2")

    table = (116, 468, 1210, 674)
    box(draw, table, "panel", "border", 10)
    headers = ["Test", "Grounding", "Run", "Evidence", "Recommendation"]
    xs = [138, 430, 594, 720, 980]
    for x, header in zip(xs, headers):
        text(draw, (x, 489), header, "muted", "small_bold")
    draw.line((132, 519, 1194, 519), fill=COLORS["border"], width=1)

    rows = [
        ("test_login_accepts_valid_user", "Grounded", "passed", "auth_service.py:42", "Keep"),
        ("test_rejects_disabled_account", "Grounded", "passed", "auth_service.py:77", "Keep"),
        ("test_refresh_token_rotation", "Needs review", "skipped", "http_api.py:31", "Check workflow"),
        ("test_admin_impersonation", "Ghost risk", "failed", "No evidence", "Rewrite against real API"),
    ]
    y = 538
    for name, grounding, run, evidence, recommendation in rows:
        color = "green" if grounding == "Grounded" else "amber" if grounding == "Needs review" else "red"
        text(draw, (138, y), name, "text", "small")
        text(draw, (430, y), grounding, color, "small_bold")
        text(draw, (594, y), run, "green" if run == "passed" else "amber" if run == "skipped" else "red", "small_bold")
        text(draw, (720, y), evidence, "blue", "small")
        text(draw, (980, y), recommendation, "muted", "small")
        y += 38

    img.save(MEDIA / "screenshot-report.png")


def draw_diagnostics() -> None:
    img, draw = window("Ghost Test Catcher - Diagnostics")
    sidebar(draw, "problems")
    draw.rectangle((82, 56, 332, 720), fill="#0b1120")
    text(draw, (112, 92), "EXPLORER", "muted", "small_bold")
    for i, item in enumerate(["src/auth_service.py", "src/http_api.py", "tests/test_auth.py"]):
        fill = "#172033" if i == 2 else "#0b1120"
        draw.rounded_rectangle((102, 134 + i * 38, 310, 164 + i * 38), radius=6, fill=fill)
        text(draw, (118, 140 + i * 38), item, "text" if i == 2 else "muted", "small")

    draw.rectangle((332, 56, 1280, 720), fill="#0f172a")
    text(draw, (368, 92), "tests/test_auth.py", "muted", "small_bold")
    draw.line((352, 126, 1240, 126), fill=COLORS["border"], width=1)

    lines = [
        "from src.auth_service import AuthService",
        "",
        "def test_login_accepts_valid_user():",
        "    service = AuthService()",
        "    assert service.login('ada@example.com', 'correct')",
        "",
        "def test_admin_impersonation():",
        "    service = AuthService()",
        "    assert service.impersonate_admin('ada@example.com')",
    ]
    y = 152
    for idx, line in enumerate(lines, start=1):
        text(draw, (370, y), f"{idx:>2}", "muted", "code_small")
        color = "red" if "impersonate_admin" in line else "text"
        text(draw, (420, y), line, color, "code")
        if "test_login_accepts" in line:
            text(draw, (420, y - 24), "Ghost Test: Grounded | run passed | 96.0%", "green", "small")
        if "test_admin_impersonation" in line:
            text(draw, (420, y - 24), "Ghost Test: Ghost risk | run failed | 8.0%", "red", "small")
        if "impersonate_admin" in line:
            draw.line((604, y + 22, 978, y + 22), fill=COLORS["red"], width=3)
        y += 34

    box(draw, (420, 508, 1116, 626), "panel", "red", 10, 2)
    text(draw, (444, 530), "Ghost Test Catcher: Ghost risk (8.0% grounded), test run failed.", "red", "body_bold")
    text(draw, (444, 562), "Missing symbols: impersonate_admin. No matching evidence in selected source context.", "muted", "body")
    text(draw, (444, 594), "Quick Fix: Copy Missing Symbols | Run Static Analysis Only", "blue", "small_bold")

    img.save(MEDIA / "screenshot-diagnostics.png")


def draw_testing() -> None:
    img, draw = window("Ghost Test Catcher - Testing Panel")
    sidebar(draw, "testing")
    draw.rectangle((82, 56, 396, 720), fill="#0b1120")
    text(draw, (112, 92), "TESTING", "muted", "small_bold")
    box(draw, (112, 130, 360, 176), "panel", "border", 8)
    text(draw, (132, 142), "Analyze with Ghost Test Catcher", "blue", "small_bold")
    text(draw, (112, 214), "PYTHON PROJECT", "muted", "small_bold")

    tree = [
        ("tests/test_auth.py", "file", "muted"),
        ("  PASS test_login_accepts_valid_user", "test", "green"),
        ("  PASS test_rejects_disabled_account", "test", "green"),
        ("  SKIP test_refresh_token_rotation", "test", "amber"),
        ("  FAIL test_admin_impersonation", "test", "red"),
    ]
    y = 250
    for label, kind, color in tree:
        if kind == "file":
            draw.rounded_rectangle((104, y - 5, 370, y + 28), radius=6, fill="#111827")
        text(draw, (124, y), label, color, "small_bold" if kind == "file" else "small")
        y += 36

    draw.rectangle((396, 56, 1280, 720), fill="#0f172a")
    text(draw, (436, 92), "Native VS Code Testing Results", "text", "h1")
    text(draw, (436, 132), "Grounding plus execution mapped to passed, failed, skipped, or errored test items.", "muted", "body")

    cards = [
        ("Grounded tests", "2", "Evidence and execution agree.", "green"),
        ("Needs review", "1", "Static evidence is incomplete.", "amber"),
        ("Ghost risk", "1", "Test asserts missing behavior.", "red"),
    ]
    for i, (title, value, body, color) in enumerate(cards):
        x = 436 + i * 264
        box(draw, (x, 190, x + 238, 330), "panel", "border", 12)
        text(draw, (x + 18, 212), title, "muted", "small_bold")
        text(draw, (x + 18, 240), value, color, "title")
        text(draw, (x + 18, 296), body, "muted", "small")

    box(draw, (436, 376, 1166, 622), "panel", "border", 12)
    text(draw, (464, 402), "Failure detail", "text", "h2")
    text(draw, (464, 444), "Ghost Test Catcher result for test_admin_impersonation.", "muted", "body")
    details = [
        ("Grounding", "Ghost risk", "red"),
        ("Confidence", "8.0%", "red"),
        ("Execution", "failed", "red"),
        ("Missing symbols", "impersonate_admin", "amber"),
        ("Recommendation", "Rewrite the test against real AuthService APIs.", "blue"),
    ]
    y = 486
    for label, value, color in details:
        text(draw, (464, y), f"{label}:", "muted", "small_bold")
        text(draw, (610, y), value, color, "small_bold")
        y += 28

    img.save(MEDIA / "screenshot-testing.png")


def main() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)
    draw_report()
    draw_diagnostics()
    draw_testing()
    print(f"Wrote marketplace assets to {MEDIA}")


if __name__ == "__main__":
    main()
