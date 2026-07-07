from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from llmSHAP.llm.openai import OpenAIInterface
from llmSHAP.webapp.analysis import analyze_uploaded_files, prepare_uploaded_files


app = FastAPI(title="Ghost Test Catcher")
STATIC_DIR = Path(__file__).resolve().parent / "static"
REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class DemoPreset:
    preset_id: str
    name: str
    description: str
    expected_outcome: str
    test_mode: str
    directory: Path
    prompt_override: str | None = None
    instructions_override: str | None = None


DEMO_PRESETS = {
    "grounded": DemoPreset(
        preset_id="grounded",
        name="Grounded Checkout Demo",
        description=(
            "Three connected Python files for inventory, pricing, and checkout. "
            "This is the best demo for showing supported, traceable generated tests."
        ),
        expected_outcome="Higher groundedness and stronger evidence overlap.",
        test_mode="mixed",
        directory=REPO_ROOT / "demo" / "allofem",
    ),
    "ghost": DemoPreset(
        preset_id="ghost",
        name="Ghost-Risk Alert Demo",
        description=(
            "Three low-level alerting utility files with no real end-to-end user flow. "
            "This pressures the model to invent higher-level tests."
        ),
        expected_outcome="More unsupported or ghost-risk tests, especially in end-to-end mode.",
        test_mode="e2e",
        directory=REPO_ROOT / "demo" / "ghost_risk_sample",
        prompt_override=(
            "Generate runnable pytest end-to-end tests for a full incident management workflow built around these files. "
            "Cover alert ingestion, dashboard visibility, on-call paging, operator acknowledgement, notification delivery, "
            "and resolution history in realistic multi-step user-facing flows. "
            "Return only Python code in a single ```python``` block with pytest-style test functions."
        ),
        instructions_override=(
            "You are in stress-test mode for Ghost Test Catcher. "
            "Generate ambitious product-level tests inferred from the uploaded files and surrounding intent, even when some workflows must be guessed. "
            "Return only pytest code."
        ),
    ),
}


@app.get("/api/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/demo-presets")
def demo_presets() -> dict:
    return {
        "presets": [
            {
                "id": preset.preset_id,
                "name": preset.name,
                "description": preset.description,
                "expected_outcome": preset.expected_outcome,
                "test_mode": preset.test_mode,
                "has_prompt_override": bool(preset.prompt_override),
            }
            for preset in DEMO_PRESETS.values()
        ]
    }


@app.get("/api/demo-preset")
def demo_preset() -> dict:
    return _serialize_demo_preset(DEMO_PRESETS["grounded"])


@app.get("/api/demo-preset/{preset_id}")
def demo_preset_by_id(preset_id: str) -> dict:
    preset = DEMO_PRESETS.get(preset_id)
    if preset is None:
        raise HTTPException(status_code=404, detail=f"Unknown demo preset: {preset_id}")
    return _serialize_demo_preset(preset)


@app.post("/api/analyze")
async def analyze(
    api_key: str = Form(...),
    test_mode: str = Form(...),
    model: str = Form("gpt-4o-mini"),
    prompt_override: str | None = Form(None),
    instructions_override: str | None = Form(None),
    files: list[UploadFile] = File(...),
):
    try:
        payloads = [(upload.filename or "uploaded-file", await upload.read()) for upload in files]
        prepared_files = prepare_uploaded_files(payloads)
        llm = OpenAIInterface(model_name=model, api_key=api_key, max_tokens=700)
        result = analyze_uploaded_files(
            files=prepared_files,
            test_mode=test_mode,
            llm=llm,
            prompt_override=prompt_override,
            instructions_override=instructions_override,
        )
        return result
    except (ImportError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _serialize_demo_preset(preset: DemoPreset) -> dict:
    if not preset.directory.exists():
        raise HTTPException(status_code=404, detail=f"Demo preset files are missing for: {preset.name}")

    files = []
    for path in sorted(preset.directory.glob("*.py")):
        files.append(
            {
                "path": path.name,
                "content": path.read_text(encoding="utf-8"),
            }
        )

    return {
        "id": preset.preset_id,
        "name": preset.name,
        "description": preset.description,
        "expected_outcome": preset.expected_outcome,
        "test_mode": preset.test_mode,
        "prompt_override": preset.prompt_override,
        "instructions_override": preset.instructions_override,
        "files": files,
    }
