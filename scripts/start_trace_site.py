#!/usr/bin/env python3

from __future__ import annotations

import os
from pathlib import Path

from serve_trace_searchable import main as serve_main


def load_env_file(env_path: Path) -> None:
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def print_start_message(root: Path) -> None:
    has_groq_key = bool(os.environ.get("GROQ_API_KEY", "").strip())
    has_openai_key = bool(os.environ.get("OPENAI_API_KEY", "").strip())
    port = os.environ.get("PORT", "8000")

    print("\nTRaCE Searchable startup")
    print("------------------------")
    print(f"Project folder: {root}")
    print(f"Site URL: http://localhost:{port}/site/")
    if has_groq_key:
        print("AI mode: active via Groq (free, shared for all visitors)")
    elif has_openai_key:
        print("AI mode: active via OpenAI (shared for all visitors)")
    else:
        print("AI mode: fallback (set GROQ_API_KEY in .env for free AI - see README)")
    print("")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    load_env_file(root / ".env")
    print_start_message(root)
    serve_main()


if __name__ == "__main__":
    main()
