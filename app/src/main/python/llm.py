"""
llm.py — unified chat layer over Anthropic and OpenAI-compatible providers.

One neutral message/tool format goes in; provider-specific wire formats are
handled here, so the agent loop is identical whether the driving model is
Claude (native tool use) or DeepSeek (OpenAI-style function calling).

Features:
  - tool calling on both providers (same neutral schema)
  - SSE streaming with a delta callback (falls back to non-streaming)
  - retries with exponential backoff on 429/5xx/network errors
  - Anthropic prompt caching (cache_control on the big context block)
  - run-level token accounting (reset per run, read by the UI)

Neutral message format (list of dicts):
  {"role": "user",      "content": str}
  {"role": "assistant", "content": str, "reasoning": str,
                        "tool_calls": [{"id": str, "name": str, "args": dict}]}
  {"role": "tool",      "tool_call_id": str, "name": str, "content": str}

Neutral tool schema: {"name": str, "description": str, "input_schema": dict}

chat() returns:
  {"text": str, "reasoning": str, "tool_calls": [...], "stop": str,
   "usage": {"input": int, "output": int}}
"""

import os
import json
import time
import urllib.request
import urllib.error

TIMEOUT = 180
MAX_RETRIES = 4
BACKOFFS = [2, 4, 8, 16]

# --- run-level usage accounting -------------------------------------------

_USAGE = {"input": 0, "output": 0, "calls": 0}


def reset_usage() -> None:
    _USAGE.update({"input": 0, "output": 0, "calls": 0})


def usage() -> dict:
    return dict(_USAGE)


def _account(inp: int, out: int) -> None:
    _USAGE["input"] += int(inp or 0)
    _USAGE["output"] += int(out or 0)
    _USAGE["calls"] += 1


def _interrupted() -> bool:
    return os.environ.get("AGENT_INTERRUPT", "0") == "1"


def _thinking_on() -> bool:
    return os.environ.get("AGENT_THINKING", "0") == "1"


# --- low-level HTTP with retries -------------------------------------------

def _post(url: str, headers: dict, payload: dict, stream: bool):
    """POST returning either a parsed JSON dict or a response object (stream).

    Retries transient failures (429, 5xx, network) with backoff; permanent
    errors (4xx other than 429) raise immediately with the body attached.
    """
    data = json.dumps(payload).encode("utf-8")
    last = None
    for attempt in range(MAX_RETRIES + 1):
        if _interrupted():
            raise RuntimeError("interrupted")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            resp = urllib.request.urlopen(req, timeout=TIMEOUT)
            if stream:
                return resp
            with resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            last = RuntimeError(f"HTTP {e.code} from {url}: {body[:600]}")
            if e.code not in (408, 409, 429, 500, 502, 503, 504, 529):
                raise last from e
        except Exception as e:  # URLError, timeout, connection reset…
            last = RuntimeError(f"{type(e).__name__} calling {url}: {e}")
        if attempt < MAX_RETRIES:
            time.sleep(BACKOFFS[min(attempt, len(BACKOFFS) - 1)])
    raise last


def _sse_lines(resp):
    """Yield decoded `data:` payload strings from an SSE response."""
    while True:
        raw = resp.readline()
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace").strip()
        if line.startswith("data:"):
            yield line[5:].strip()


# --- Anthropic --------------------------------------------------------------

def _anthropic_tools(tools):
    return [{"name": t["name"], "description": t["description"],
             "input_schema": t["input_schema"]} for t in tools]


def _anthropic_messages(messages):
    """Convert neutral messages to the Anthropic content-block format."""
    out = []
    i = 0
    while i < len(messages):
        m = messages[i]
        if m["role"] == "user":
            out.append({"role": "user", "content": m["content"]})
            i += 1
        elif m["role"] == "assistant":
            blocks = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m.get("tool_calls") or []:
                blocks.append({"type": "tool_use", "id": tc["id"],
                               "name": tc["name"], "input": tc["args"]})
            out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": " "}]})
            i += 1
        else:  # tool results — group consecutive ones into one user turn
            blocks = []
            while i < len(messages) and messages[i]["role"] == "tool":
                t = messages[i]
                blocks.append({"type": "tool_result", "tool_use_id": t["tool_call_id"],
                               "content": t["content"][:30000]})
                i += 1
            out.append({"role": "user", "content": blocks})
    return out


def _call_anthropic(model, system, cached_context, messages, tools,
                    max_tokens, on_delta):
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    sys_blocks = [{"type": "text", "text": system}]
    if cached_context:
        # The big, mostly-stable context block gets a cache marker so repeated
        # loop steps hit the prompt cache instead of re-paying for it.
        sys_blocks.append({"type": "text", "text": cached_context,
                           "cache_control": {"type": "ephemeral"}})
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "system": sys_blocks,
        "messages": _anthropic_messages(messages),
    }
    if tools:
        payload["tools"] = _anthropic_tools(tools)
    if _thinking_on():
        payload["thinking"] = {"type": "adaptive", "display": "summarized"}
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    url = "https://api.anthropic.com/v1/messages"

    if on_delta is None:
        result = _post(url, headers, payload, stream=False)
        return _parse_anthropic(result)

    payload["stream"] = True
    resp = _post(url, headers, payload, stream=True)
    text, reasoning, tool_calls = [], [], []
    cur_tool = None
    stop = ""
    usage_in = usage_out = 0
    with resp:
        for data in _sse_lines(resp):
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except Exception:
                continue
            t = ev.get("type")
            if t == "message_start":
                u = (ev.get("message") or {}).get("usage") or {}
                usage_in = u.get("input_tokens", 0)
            elif t == "content_block_start":
                cb = ev.get("content_block") or {}
                if cb.get("type") == "tool_use":
                    cur_tool = {"id": cb.get("id"), "name": cb.get("name"), "json": ""}
            elif t == "content_block_delta":
                d = ev.get("delta") or {}
                dt = d.get("type")
                if dt == "text_delta":
                    text.append(d.get("text", ""))
                    on_delta(d.get("text", ""))
                elif dt == "thinking_delta":
                    reasoning.append(d.get("thinking", ""))
                elif dt == "input_json_delta" and cur_tool is not None:
                    cur_tool["json"] += d.get("partial_json", "")
            elif t == "content_block_stop":
                if cur_tool is not None:
                    try:
                        args = json.loads(cur_tool["json"] or "{}")
                    except Exception:
                        args = {}
                    tool_calls.append({"id": cur_tool["id"], "name": cur_tool["name"],
                                       "args": args})
                    cur_tool = None
            elif t == "message_delta":
                stop = (ev.get("delta") or {}).get("stop_reason") or stop
                u = ev.get("usage") or {}
                usage_out = u.get("output_tokens", usage_out)
    _account(usage_in, usage_out)
    return {"text": "".join(text), "reasoning": "".join(reasoning),
            "tool_calls": tool_calls, "stop": stop or "end_turn",
            "usage": {"input": usage_in, "output": usage_out}}


def _parse_anthropic(result):
    parts = result.get("content", [])
    text = "".join(p.get("text", "") for p in parts if p.get("type") == "text")
    reasoning = "".join(p.get("thinking", "") for p in parts if p.get("type") == "thinking")
    tool_calls = [{"id": p["id"], "name": p["name"], "args": p.get("input") or {}}
                  for p in parts if p.get("type") == "tool_use"]
    u = result.get("usage") or {}
    _account(u.get("input_tokens", 0), u.get("output_tokens", 0))
    return {"text": text, "reasoning": reasoning, "tool_calls": tool_calls,
            "stop": result.get("stop_reason") or "end_turn",
            "usage": {"input": u.get("input_tokens", 0), "output": u.get("output_tokens", 0)}}


# --- OpenAI-compatible (DeepSeek, etc.) -------------------------------------

_OAI_BASES = {"deepseek": "https://api.deepseek.com"}
_OAI_KEYS = {"deepseek": "DEEPSEEK_API_KEY"}


def _openai_tools(tools):
    return [{"type": "function",
             "function": {"name": t["name"], "description": t["description"],
                          "parameters": t["input_schema"]}} for t in tools]


def _openai_messages(system, cached_context, messages):
    sys_text = system + (("\n\n" + cached_context) if cached_context else "")
    out = [{"role": "system", "content": sys_text}]
    for m in messages:
        if m["role"] == "user":
            out.append({"role": "user", "content": m["content"]})
        elif m["role"] == "assistant":
            entry = {"role": "assistant", "content": m.get("content") or None}
            tcs = m.get("tool_calls") or []
            if tcs:
                entry["tool_calls"] = [
                    {"id": tc["id"], "type": "function",
                     "function": {"name": tc["name"],
                                  "arguments": json.dumps(tc["args"])}}
                    for tc in tcs]
            out.append(entry)
        else:
            out.append({"role": "tool", "tool_call_id": m["tool_call_id"],
                        "content": m["content"][:30000]})
    return out


def _call_openai(provider, model, system, cached_context, messages, tools,
                 max_tokens, on_delta):
    base = _OAI_BASES.get(provider, "https://api.openai.com")
    key = os.environ.get(_OAI_KEYS.get(provider, "OPENAI_API_KEY"), "")
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": _openai_messages(system, cached_context, messages),
    }
    if tools:
        payload["tools"] = _openai_tools(tools)
    headers = {"Authorization": f"Bearer {key}", "content-type": "application/json"}
    url = f"{base}/v1/chat/completions"

    if on_delta is None:
        result = _post(url, headers, payload, stream=False)
        return _parse_openai(result)

    payload["stream"] = True
    payload["stream_options"] = {"include_usage": True}
    resp = _post(url, headers, payload, stream=True)
    text, reasoning = [], []
    tools_acc = {}  # index -> {id, name, args_json}
    stop = ""
    usage_in = usage_out = 0
    with resp:
        for data in _sse_lines(resp):
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except Exception:
                continue
            u = ev.get("usage")
            if u:
                usage_in = u.get("prompt_tokens", usage_in)
                usage_out = u.get("completion_tokens", usage_out)
            choices = ev.get("choices") or []
            if not choices:
                continue
            ch = choices[0]
            if ch.get("finish_reason"):
                stop = ch["finish_reason"]
            d = ch.get("delta") or {}
            if d.get("content"):
                text.append(d["content"])
                on_delta(d["content"])
            if d.get("reasoning_content"):
                reasoning.append(d["reasoning_content"])
            for tc in d.get("tool_calls") or []:
                idx = tc.get("index", 0)
                slot = tools_acc.setdefault(idx, {"id": "", "name": "", "json": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] += fn["name"]
                if fn.get("arguments"):
                    slot["json"] += fn["arguments"]
    tool_calls = []
    for idx in sorted(tools_acc):
        slot = tools_acc[idx]
        try:
            args = json.loads(slot["json"] or "{}")
        except Exception:
            args = {}
        tool_calls.append({"id": slot["id"] or f"call_{idx}",
                           "name": slot["name"], "args": args})
    _account(usage_in, usage_out)
    stop_map = {"stop": "end_turn", "tool_calls": "tool_use", "length": "max_tokens"}
    return {"text": "".join(text), "reasoning": "".join(reasoning),
            "tool_calls": tool_calls, "stop": stop_map.get(stop, stop or "end_turn"),
            "usage": {"input": usage_in, "output": usage_out}}


def _parse_openai(result):
    choices = result.get("choices") or []
    if not choices:
        raise RuntimeError("provider returned no choices: " +
                           json.dumps(result)[:400])
    msg = choices[0].get("message") or {}
    tool_calls = []
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {}
        tool_calls.append({"id": tc.get("id") or "call_0",
                           "name": fn.get("name") or "", "args": args})
    u = result.get("usage") or {}
    _account(u.get("prompt_tokens", 0), u.get("completion_tokens", 0))
    stop = choices[0].get("finish_reason") or "stop"
    stop_map = {"stop": "end_turn", "tool_calls": "tool_use", "length": "max_tokens"}
    return {"text": msg.get("content") or "", "reasoning": msg.get("reasoning_content") or "",
            "tool_calls": tool_calls, "stop": stop_map.get(stop, stop),
            "usage": {"input": u.get("prompt_tokens", 0), "output": u.get("completion_tokens", 0)}}


# --- public entry point ------------------------------------------------------

def chat(model, system, messages, tools=None, max_tokens=8000,
         cached_context="", on_delta=None):
    """Provider-agnostic chat call. `model` is "<provider>/<name>".

    on_delta: optional callable(str) receiving streamed text chunks. When
    streaming fails mid-response the whole call is retried non-streaming.
    """
    provider, _, model_name = model.partition("/")
    if not model_name:
        provider, model_name = "openai", model
    tools = tools or []
    try:
        if provider == "anthropic":
            return _call_anthropic(model_name, system, cached_context, messages,
                                   tools, max_tokens, on_delta)
        return _call_openai(provider, model_name, system, cached_context,
                            messages, tools, max_tokens, on_delta)
    except RuntimeError:
        raise
    except Exception:
        # A mid-stream failure (socket drop while parsing SSE) — one
        # non-streaming retry so the step still completes.
        if on_delta is not None:
            if provider == "anthropic":
                return _call_anthropic(model_name, system, cached_context,
                                       messages, tools, max_tokens, None)
            return _call_openai(provider, model_name, system, cached_context,
                                messages, tools, max_tokens, None)
        raise


def chat_text(model, system, user, max_tokens=4000, on_delta=None):
    """Simple single-turn text call (no tools). Returns (text, reasoning).

    Auto-continues once if the reply was cut off at max_tokens.
    """
    messages = [{"role": "user", "content": user}]
    r = chat(model, system, messages, max_tokens=max_tokens, on_delta=on_delta)
    text, reasoning = r["text"], r["reasoning"]
    if r["stop"] == "max_tokens":
        messages.append({"role": "assistant", "content": text})
        messages.append({"role": "user", "content":
                         "Continue exactly where you left off. Do not repeat anything."})
        r2 = chat(model, system, messages, max_tokens=max_tokens, on_delta=on_delta)
        text += r2["text"]
        reasoning += r2["reasoning"]
    return text, reasoning
