"""Token counting and chunked extraction for large document inputs."""

from __future__ import annotations
import tiktoken

# Reuse one encoder instance — avoids repeated WASM/BPE init overhead.
# cl100k_base is a reasonable proxy for Qwen/Phi/Mistral tokenization (±10-15%).
_enc = tiktoken.get_encoding("cl100k_base")

# Safety margin: reserve 15% of maxInputTokens for overhead (tool schemas, SSE, JSON).
SAFETY_MARGIN = 0.15
# Minimum token reserve regardless of model size.
MIN_RESERVE = 256
# Overlap fraction between chunks to avoid losing context at boundaries.
CHUNK_OVERLAP = 0.10


def count_tokens(text: str) -> int:
    """Return estimated token count for text."""
    return len(_enc.encode(text))


def get_input_budget(max_input_tokens: int | None, max_output_tokens: int | None) -> int | None:
    """Return usable input token budget given model limits, or None if unknown."""
    if max_input_tokens is None:
        return None
    reserve = max(int(max_input_tokens * SAFETY_MARGIN), MIN_RESERVE)
    output_reserve = max_output_tokens or 512
    return max(max_input_tokens - reserve - output_reserve, MIN_RESERVE)


def truncate_to_budget(text: str, budget: int, notice: str = "\n\n[…content truncated to fit model context window]") -> tuple[str, bool]:
    """Truncate text to fit within budget tokens. Returns (text, was_truncated)."""
    tokens = _enc.encode(text)
    if len(tokens) <= budget:
        return text, False
    # Leave room for the notice itself
    notice_tokens = count_tokens(notice)
    keep = max(budget - notice_tokens, 1)
    truncated = _enc.decode(tokens[:keep])
    return truncated + notice, True


def split_into_chunks(text: str, chunk_tokens: int) -> list[str]:
    """Split text into overlapping token-budget chunks for multi-pass extraction."""
    tokens = _enc.encode(text)
    if len(tokens) <= chunk_tokens:
        return [text]

    overlap = int(chunk_tokens * CHUNK_OVERLAP)
    step = chunk_tokens - overlap
    chunks: list[str] = []

    pos = 0
    while pos < len(tokens):
        chunk_toks = tokens[pos: pos + chunk_tokens]
        chunks.append(_enc.decode(chunk_toks))
        if pos + chunk_tokens >= len(tokens):
            break
        pos += step

    return chunks
