#!/usr/bin/env python3
"""Resolve static TOC/list entries against a rendered thesis PDF."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path

import pdfplumber
from docx import Document


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--docx", type=Path, required=True)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--body-start", type=int, default=11)
    return parser.parse_args()


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = value.replace("–", "-").replace("—", "-").replace("−", "-")
    return re.sub(r"\s+", " ", value).strip()


def front_labels(docx_path: Path) -> list[str]:
    document = Document(docx_path)
    labels: list[str] = []
    for paragraph in document.paragraphs:
        style = paragraph.style.name
        if not (style.startswith("TOC") or style == "List Entry"):
            continue
        label = paragraph.text.split("\t", 1)[0].strip()
        if label and label not in labels:
            labels.append(label)
    return labels


def main() -> None:
    args = parse_args()
    labels = front_labels(args.docx)
    with pdfplumber.open(args.pdf) as pdf:
        extracted = [page.extract_text() or "" for page in pdf.pages]
        page_texts = [normalize(text) for text in extracted]
        page_lines = [{normalize(line) for line in text.splitlines()} for text in extracted]

    result: dict[str, str] = {}
    missing: list[str] = []
    for label in labels:
        wanted = normalize(label)
        exact_line = label in {"ZAKLJUČAK", "LITERATURA"} or label.startswith("Tabela P.")
        first_page = 1 if exact_line else args.body_start
        match = next(
            (
                page_number
                for page_number, text in enumerate(page_texts, start=1)
                if page_number >= first_page
                and (wanted in page_lines[page_number - 1] if exact_line else wanted in text)
            ),
            None,
        )
        if match is None:
            missing.append(label)
            continue
        result[label] = "I" if label.upper().startswith("DODATAK A:") else str(match)

    if missing:
        raise SystemExit("Nisu pronađene stranice za:\n- " + "\n- ".join(missing))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Upisano {len(result)} oznaka u {args.output}")


if __name__ == "__main__":
    main()
