from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from llmSHAP.codebase import explain_with_attribution, format_chunk_reference, index_repository, retrieve_chunks
from llmSHAP.llm.openai import OpenAIInterface


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Explainable codebase Q&A with retrieval and chunk attribution.")
    parser.add_argument("--repo", required=True, help="Path to the target repository.")
    parser.add_argument("--question", required=True, help="Question to ask about the repository.")
    parser.add_argument("--top-k", type=int, default=6, help="Number of retrieved chunks to analyze.")
    parser.add_argument("--output", help="Optional path to a JSON output file.")
    parser.add_argument("--model", default="gpt-4o-mini", help="OpenAI model name to use.")
    parser.add_argument("--chunk-size", type=int, default=80, help="Chunk size in lines.")
    parser.add_argument("--overlap", type=int, default=20, help="Chunk overlap in lines.")
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=600,
        help="Maximum number of completion tokens to request from the model.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_path = Path(args.repo).expanduser().resolve()

    try:
        all_chunks = index_repository(repo_path, chunk_size=args.chunk_size, overlap=args.overlap)
        retrieved_chunks = retrieve_chunks(all_chunks, args.question, top_k=args.top_k)
        llm = OpenAIInterface(model_name=args.model, max_tokens=args.max_output_tokens)
        answer, attributions = explain_with_attribution(
            question=args.question,
            chunks=retrieved_chunks,
            llm=llm,
        )
    except (ImportError, RuntimeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print("Question:")
    print(args.question)
    print()
    print("Answer:")
    print(answer)
    print()
    print("Top supporting chunks:")
    if attributions:
        for index, attribution in enumerate(attributions, start=1):
            location = f"{attribution.path}:{attribution.start_line}-{attribution.end_line}"
            print(f"{index}. {location} score={attribution.score:.2f}")
    else:
        print("No retrieved chunks were available for attribution.")
    print()
    print("Retrieved context:")
    if retrieved_chunks:
        for chunk in retrieved_chunks:
            print(f"- {format_chunk_reference(chunk)}")
    else:
        print("- No context retrieved")

    if args.output:
        payload = {
            "question": args.question,
            "answer": answer,
            "retrieved_chunks": [
                {
                    "chunk_id": chunk.chunk_id,
                    "path": chunk.path,
                    "start_line": chunk.start_line,
                    "end_line": chunk.end_line,
                    "text": chunk.text,
                }
                for chunk in retrieved_chunks
            ],
            "attributions": [
                {
                    "chunk_id": attribution.chunk_id,
                    "path": attribution.path,
                    "start_line": attribution.start_line,
                    "end_line": attribution.end_line,
                    "score": attribution.score,
                }
                for attribution in attributions
            ],
        }
        output_path = Path(args.output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
