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
import re
import json
import time
import threading
import urllib.request
import urllib.error

TIMEOUT = 180
MAX_RETRIES = 4
BACKOFFS = [2, 4, 8, 16]

# --- run-level usage accounting -------------------------------------------

_USAGE = {"input": 0, "output": 0, "cache_read": 0, "calls": 0}
# Per-model totals, keyed by the full "provider/model" id, so the UI can show
# how much each model (orchestrator vs implementer) cost.
_USAGE_BY_MODEL = {}
# Guards both: multi-agent workflows call chat() from several threads at once,
# so the running totals must be updated under a lock or counts get lost.
_USAGE_LOCK = threading.Lock()


def reset_usage() -> None:
    with _USAGE_LOCK:
        _USAGE.update({"input": 0, "output": 0, "cache_read": 0, "calls": 0})
        _USAGE_BY_MODEL.clear()


def usage() -> dict:
    with _USAGE_LOCK:
        return dict(_USAGE)


def usage_by_model() -> dict:
    with _USAGE_LOCK:
        return {m: dict(v) for m, v in _USAGE_BY_MODEL.items()}


def _account(inp: int, out: int, cached: int = 0, model: str = "") -> None:
    inp, out, cached = int(inp or 0), int(out or 0), int(cached or 0)
    with _USAGE_LOCK:
        _USAGE["input"] += inp
        _USAGE["output"] += out
        _USAGE["cache_read"] += cached
        _USAGE["calls"] += 1
        if model:
            m = _USAGE_BY_MODEL.setdefault(
                model, {"input": 0, "output": 0, "cache_read": 0, "calls": 0})
            m["input"] += inp
            m["output"] += out
            m["cache_read"] += cached
            m["calls"] += 1


def _interrupted() -> bool:
    return os.environ.get("AGENT_INTERRUPT", "0") == "1"


# --- tolerant tool-argument parsing -----------------------------------------
# Models (DeepSeek especially) sometimes emit tool-call arguments that aren't
# clean JSON: code-fenced, double-encoded, or truncated when the reply hits the
# token cap mid-call. Rather than drop the whole call to {} — which makes the
# model look like it "forgot" the arguments — recover as much as arrived.

def _json_unescape(s: str) -> str:
    try:
        return json.loads('"' + s + '"')
    except Exception:
        return (s.replace('\\n', '\n').replace('\\t', '\t')
                 .replace('\\"', '"').replace("\\\\", "\\"))


_KV_STR = re.compile(r'"([A-Za-z0-9_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"')
_KV_LIT = re.compile(r'"([A-Za-z0-9_]+)"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?)')
_KV_TAIL = re.compile(r'"([A-Za-z0-9_]+)"\s*:\s*"((?:[^"\\]|\\.)*)$')


def parse_tool_args(raw):
    """Best-effort parse of a tool-call arguments blob into a dict."""
    if isinstance(raw, dict):
        return raw
    s = str(raw or "").strip()
    if not s:
        return {}
    if s.startswith("```"):
        parts = s.split("```")
        s = parts[1] if len(parts) >= 2 else s.strip("`")
        if s.lower().startswith("json"):
            s = s[4:]
        s = s.strip()
    # Clean JSON, or a JSON string that itself contains JSON (double-encoded).
    cur = s
    for _ in range(2):
        try:
            v = json.loads(cur)
        except Exception:
            break
        if isinstance(v, dict):
            return v
        if isinstance(v, str):
            cur = v.strip()
            continue
        break
    # Salvage: pull whatever "key": value pairs arrived, tolerating a truncated
    # final string value (e.g. a huge file content cut off by the token cap).
    out = {}
    for m in _KV_STR.finditer(s):
        out[m.group(1)] = _json_unescape(m.group(2))
    for m in _KV_LIT.finditer(s):
        out.setdefault(m.group(1), json.loads(m.group(2)))
    tail = _KV_TAIL.search(s)
    if tail and tail.group(1) not in out:
        out[tail.group(1)] = _json_unescape(tail.group(2))
    return out


# Reasoning "effort" → an Anthropic thinking budget. Higher effort reasons more
# (and costs more); "off" sends no thinking block at all. DeepSeek V4 has only a
# Thinking/Non-Thinking switch, so there effort collapses to on (any level) / off.
_EFFORT_BUDGET = {"low": 4000, "medium": 12000, "high": 24000}


def _effort() -> str:
    """Current reasoning effort: off / low / medium / high.

    Frugal mode forces it off (its biggest real saving). When AGENT_EFFORT is
    unset we fall back to the legacy on/off AGENT_THINKING toggle (on == medium),
    so older callers keep working.
    """
    if os.environ.get("AGENT_FRUGAL", "0") == "1":
        return "off"
    e = (os.environ.get("AGENT_EFFORT", "") or "").strip().lower()
    if e == "max":
        return "high"
    if e in ("off", "none", "0"):
        return "off"
    if e in ("low", "medium", "high"):
        return e
    return "medium" if os.environ.get("AGENT_THINKING", "0") == "1" else "off"


def _thinking_on() -> bool:
    return _effort() != "off"


# --- low-level HTTP with retries -------------------------------------------

class StreamError(Exception):
    """A mid-stream provider error. Deliberately NOT a RuntimeError so chat()'s
    non-streaming retry path engages (it re-raises RuntimeError but retries
    other exceptions)."""


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
            if m.get("image_b64"):
                out.append({"role": "user", "content": [
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png",
                        "data": m["image_b64"]}},
                    {"type": "text", "text": m["content"] or " "}]})
            else:
                out.append({"role": "user", "content": m["content"]})
            i += 1
        elif m["role"] == "assistant":
            blocks = []
            # Thinking blocks (with their signatures) must be replayed FIRST and
            # preserved verbatim: with extended thinking + tool use, Anthropic
            # requires the prior turn's thinking to accompany the tool_use when
            # tool results are sent back, or the request 400s / degrades.
            for tb in m.get("thinking_blocks") or []:
                blocks.append(tb)
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
                               "content": (t.get("content") or "(empty)")[:30000]})
                i += 1
            out.append({"role": "user", "content": blocks})
    # Cache breakpoint on the newest message: in a tool loop the whole
    # conversation so far is the stable prefix of the NEXT call, so marking
    # the tail makes every step after the first a prefix-cache hit.
    if out:
        last = out[-1]
        if isinstance(last["content"], str):
            last["content"] = [{"type": "text", "text": last["content"] or " "}]
        if isinstance(last["content"], list) and last["content"]:
            blk = last["content"][-1]
            if isinstance(blk, dict):
                blk["cache_control"] = {"type": "ephemeral"}
    return out


def _call_anthropic(model, system, cached_context, messages, tools,
                    max_tokens, on_delta):
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    sys_blocks = [{"type": "text", "text": system}]
    if cached_context:
        # Split the stable prefix (guidelines/outline/dep-map/attached files)
        # from the volatile DISCUSSION tail and give each its own cache
        # breakpoint. Otherwise a single end-of-block marker means the changing
        # discussion invalidates the cache for the entire unchanged prefix every
        # turn, re-paying cache creation for all of it. With two breakpoints the
        # stable prefix stays a cache HIT across turns; only the discussion
        # (much smaller) re-creates.
        marker = "\n\nDISCUSSION SO FAR:"
        idx = cached_context.rfind(marker)
        if idx > 0:
            sys_blocks.append({"type": "text", "text": cached_context[:idx],
                               "cache_control": {"type": "ephemeral"}})
            sys_blocks.append({"type": "text", "text": cached_context[idx + 2:],
                               "cache_control": {"type": "ephemeral"}})
        else:
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
    eff = _effort()
    if eff != "off":
        # Extended thinking with an explicit budget: the effort level IS the
        # budget, so "high" reasons (and bills) more than "low". budget_tokens
        # must stay under max_tokens, so give the answer headroom above it.
        budget = _EFFORT_BUDGET.get(eff, 12000)
        if payload["max_tokens"] <= budget:
            payload["max_tokens"] = budget + 4000
        payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    url = "https://api.anthropic.com/v1/messages"

    if on_delta is None:
        result = _post(url, headers, payload, stream=False)
        return _parse_anthropic(result, "anthropic/" + model)

    payload["stream"] = True
    resp = _post(url, headers, payload, stream=True)
    text, reasoning, tool_calls, thinking_blocks = [], [], [], []
    cur_tool = None
    cur_think = None
    stop = ""
    usage_in = usage_out = usage_cached = usage_create = 0
    with resp:
        for data in _sse_lines(resp):
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except Exception:
                continue
            t = ev.get("type")
            if t == "error":
                # Anthropic can emit a mid-stream error (e.g. overloaded_error)
                # on an already-200 stream. Raise so chat()'s retry/fallback
                # engages instead of returning a truncated turn as success.
                err = (ev.get("error") or {})
                raise StreamError(f"anthropic stream error: {err.get('type', '')}: {err.get('message', '')}")
            if t == "message_start":
                u = (ev.get("message") or {}).get("usage") or {}
                usage_in = u.get("input_tokens", 0) or 0
                usage_cached = u.get("cache_read_input_tokens", 0) or 0
                usage_create = u.get("cache_creation_input_tokens", 0) or 0
            elif t == "content_block_start":
                cb = ev.get("content_block") or {}
                if cb.get("type") == "tool_use":
                    cur_tool = {"id": cb.get("id"), "name": cb.get("name"), "json": ""}
                elif cb.get("type") == "thinking":
                    cur_think = {"type": "thinking", "thinking": "", "signature": ""}
                elif cb.get("type") == "redacted_thinking":
                    thinking_blocks.append({"type": "redacted_thinking",
                                            "data": cb.get("data", "")})
            elif t == "content_block_delta":
                d = ev.get("delta") or {}
                dt = d.get("type")
                if dt == "text_delta":
                    text.append(d.get("text", ""))
                    on_delta(d.get("text", ""))
                elif dt == "thinking_delta":
                    reasoning.append(d.get("thinking", ""))
                    if cur_think is not None:
                        cur_think["thinking"] += d.get("thinking", "")
                elif dt == "signature_delta" and cur_think is not None:
                    cur_think["signature"] += d.get("signature", "")
                elif dt == "input_json_delta" and cur_tool is not None:
                    cur_tool["json"] += d.get("partial_json", "")
            elif t == "content_block_stop":
                if cur_tool is not None:
                    tool_calls.append({"id": cur_tool["id"], "name": cur_tool["name"],
                                       "args": parse_tool_args(cur_tool["json"])})
                    cur_tool = None
                elif cur_think is not None:
                    # Keep the block only if it carries a signature (unsigned
                    # thinking cannot be replayed to the API).
                    if cur_think.get("signature"):
                        thinking_blocks.append(cur_think)
                    cur_think = None
            elif t == "message_delta":
                stop = (ev.get("delta") or {}).get("stop_reason") or stop
                u = ev.get("usage") or {}
                usage_out = u.get("output_tokens", usage_out)
    in_total = usage_in + usage_cached + usage_create
    _account(in_total, usage_out, usage_cached, "anthropic/" + model)
    return {"text": "".join(text), "reasoning": "".join(reasoning),
            "tool_calls": tool_calls, "thinking_blocks": thinking_blocks,
            "stop": stop or "end_turn",
            "usage": {"input": in_total, "output": usage_out,
                      "cache_read": usage_cached}}


def _parse_anthropic(result, model=""):
    parts = result.get("content", [])
    text = "".join(p.get("text", "") for p in parts if p.get("type") == "text")
    reasoning = "".join(p.get("thinking", "") for p in parts if p.get("type") == "thinking")
    tool_calls = [{"id": p["id"], "name": p["name"], "args": p.get("input") or {}}
                  for p in parts if p.get("type") == "tool_use"]
    # Preserve thinking/redacted_thinking blocks verbatim (with signatures) so
    # they can be replayed on the next tool-loop turn.
    thinking_blocks = [p for p in parts
                       if p.get("type") in ("thinking", "redacted_thinking")
                       and (p.get("signature") or p.get("type") == "redacted_thinking")]
    u = result.get("usage") or {}
    cached = u.get("cache_read_input_tokens", 0) or 0
    create = u.get("cache_creation_input_tokens", 0) or 0
    # Anthropic reports input_tokens as the UNCACHED portion; make `input` the
    # TOTAL (uncached + cache reads + cache writes) so `cache_read / input` is a
    # correct hit ratio, matching DeepSeek's total-prompt-tokens semantics.
    in_total = (u.get("input_tokens", 0) or 0) + cached + create
    _account(in_total, u.get("output_tokens", 0), cached, model)
    return {"text": text, "reasoning": reasoning, "tool_calls": tool_calls,
            "thinking_blocks": thinking_blocks,
            "stop": result.get("stop_reason") or "end_turn",
            "usage": {"input": in_total, "output": u.get("output_tokens", 0),
                      "cache_read": cached}}


# --- OpenAI-compatible (DeepSeek, etc.) -------------------------------------

_OAI_BASES = {"deepseek": "https://api.deepseek.com",
              "openai": "https://api.openai.com"}
_OAI_KEYS = {"deepseek": "DEEPSEEK_API_KEY", "openai": "OPENAI_API_KEY"}


def _openai_tools(tools):
    return [{"type": "function",
             "function": {"name": t["name"], "description": t["description"],
                          "parameters": t["input_schema"]}} for t in tools]


def _openai_messages(system, cached_context, messages, strip_reasoning=False):
    sys_text = system + (("\n\n" + cached_context) if cached_context else "")
    out = [{"role": "system", "content": sys_text}]
    for m in messages:
        if m["role"] == "user":
            if m.get("image_b64"):
                out.append({"role": "user", "content": [
                    {"type": "image_url", "image_url": {
                        "url": "data:image/png;base64," + m["image_b64"]}},
                    {"type": "text", "text": m["content"] or " "}]})
            else:
                out.append({"role": "user", "content": m["content"]})
        elif m["role"] == "assistant":
            tcs = m.get("tool_calls") or []
            content = m.get("content") or None
            entry = {"role": "assistant", "content": content}
            # DeepSeek's thinking mode REQUIRES the assistant's reasoning_content
            # be passed back on continuation: a tool-call turn WITHOUT it 400s with
            # "reasoning_content in the thinking mode must be passed back". So when
            # thinking is on we attach it to every tool-call turn — using the
            # reasoning we captured, or a minimal placeholder when the model
            # returned a tool call with no reasoning (common), because the field
            # merely being present is what the API checks. Only while thinking is
            # on, so a thinking-off call doesn't carry a now-disallowed field.
            if not strip_reasoning and _thinking_on() and (m.get("reasoning") or tcs):
                entry["reasoning_content"] = m.get("reasoning") or " "
            if tcs:
                entry["tool_calls"] = [
                    {"id": tc["id"], "type": "function",
                     "function": {"name": tc["name"],
                                  "arguments": json.dumps(tc["args"])}}
                    for tc in tcs]
            elif not content:
                # DeepSeek/OpenAI reject an assistant message with neither
                # content nor tool_calls — give it a minimal placeholder.
                entry["content"] = " "
            out.append(entry)
        else:
            # Tool results must be non-empty too.
            out.append({"role": "tool", "tool_call_id": m["tool_call_id"],
                        "content": (m.get("content") or "(empty)")[:30000]})
    return out


def _call_openai(provider, model, system, cached_context, messages, tools,
                 max_tokens, on_delta):
    base = _OAI_BASES.get(provider, "https://api.openai.com")
    key = os.environ.get(_OAI_KEYS.get(provider, "OPENAI_API_KEY"), "")
    payload = {
        "model": model,
        "messages": _openai_messages(system, cached_context, messages),
    }
    # OpenAI moved to max_completion_tokens — its reasoning models (o1/o3/o4,
    # gpt-5) REJECT the old max_tokens; the newer alias works on every current
    # OpenAI chat model. DeepSeek and other OpenAI-compatible servers still use
    # max_tokens, so keep that for them.
    payload["max_completion_tokens" if provider == "openai" else "max_tokens"] = max_tokens
    if tools:
        payload["tools"] = _openai_tools(tools)
    # DeepSeek V4 (flash/pro) is a hybrid Thinking/Non-Thinking model. Send the
    # explicit switch so "thinking off" actually STOPS it generating (and
    # billing for) reasoning tokens — not merely hides them. Only for V4 ids;
    # deepseek-chat never reasons and deepseek-reasoner always does, so the
    # param is moot (and possibly rejected) there.
    if provider == "deepseek" and "v4" in model.lower():
        payload["thinking"] = {"type": "enabled" if _thinking_on() else "disabled"}
    headers = {"Authorization": f"Bearer {key}", "content-type": "application/json"}
    url = f"{base}/v1/chat/completions"

    # Backstop for the reasoning_content contract: providers disagree on whether
    # replayed assistant turns must (DeepSeek thinking) or must NOT (some builds)
    # carry reasoning_content. If a call 400s complaining about that exact field,
    # rebuild the messages the OTHER way and retry once — a mismatch shouldn't
    # kill the whole run.
    def _rebuild_stripped():
        payload["messages"] = _openai_messages(system, cached_context, messages,
                                                strip_reasoning=True)

    def _is_reasoning_400(e):
        s = str(e)
        return "HTTP 400" in s and "reasoning_content" in s

    if on_delta is None:
        try:
            result = _post(url, headers, payload, stream=False)
        except RuntimeError as e:
            if not _is_reasoning_400(e):
                raise
            _rebuild_stripped()
            result = _post(url, headers, payload, stream=False)
        return _parse_openai(result, provider + "/" + model)

    payload["stream"] = True
    payload["stream_options"] = {"include_usage": True}
    try:
        resp = _post(url, headers, payload, stream=True)
    except RuntimeError as e:
        if not _is_reasoning_400(e):
            raise
        _rebuild_stripped()
        resp = _post(url, headers, payload, stream=True)
    text, reasoning = [], []
    tools_acc = {}  # index -> {id, name, args_json}
    stop = ""
    usage_in = usage_out = usage_cached = 0
    with resp:
        for data in _sse_lines(resp):
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except Exception:
                continue
            if ev.get("error"):
                # Mid-stream error payload (no choices) — raise so the retry
                # path runs instead of silently ending the turn.
                err = ev.get("error") or {}
                raise StreamError(f"stream error: {err.get('type', '')}: {err.get('message', err)}")
            u = ev.get("usage")
            if u:
                usage_in = u.get("prompt_tokens", usage_in)
                usage_out = u.get("completion_tokens", usage_out)
                usage_cached = u.get("prompt_cache_hit_tokens", usage_cached) or 0
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
        tool_calls.append({"id": slot["id"] or f"call_{idx}",
                           "name": slot["name"], "args": parse_tool_args(slot["json"])})
    _account(usage_in, usage_out, usage_cached, provider + "/" + model)
    stop_map = {"stop": "end_turn", "tool_calls": "tool_use", "length": "max_tokens"}
    return {"text": "".join(text), "reasoning": "".join(reasoning),
            "tool_calls": tool_calls, "stop": stop_map.get(stop, stop or "end_turn"),
            "usage": {"input": usage_in, "output": usage_out,
                      "cache_read": usage_cached}}


def _parse_openai(result, model=""):
    choices = result.get("choices") or []
    if not choices:
        raise RuntimeError("provider returned no choices: " +
                           json.dumps(result)[:400])
    msg = choices[0].get("message") or {}
    tool_calls = []
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        tool_calls.append({"id": tc.get("id") or "call_0",
                           "name": fn.get("name") or "",
                           "args": parse_tool_args(fn.get("arguments"))})
    u = result.get("usage") or {}
    cached = u.get("prompt_cache_hit_tokens", 0) or 0
    _account(u.get("prompt_tokens", 0), u.get("completion_tokens", 0), cached, model)
    stop = choices[0].get("finish_reason") or "stop"
    stop_map = {"stop": "end_turn", "tool_calls": "tool_use", "length": "max_tokens"}
    return {"text": msg.get("content") or "", "reasoning": msg.get("reasoning_content") or "",
            "tool_calls": tool_calls, "stop": stop_map.get(stop, stop),
            "usage": {"input": u.get("prompt_tokens", 0),
                      "output": u.get("completion_tokens", 0),
                      "cache_read": cached}}


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


def _vision_capable(model: str) -> bool:
    """Whether this provider/model can accept an inline image. Anthropic and
    OpenAI chat models can; DeepSeek (and unknown OpenAI-compatible servers)
    cannot, so images are silently dropped for them."""
    provider = model.partition("/")[0] if "/" in model else "openai"
    return provider in ("anthropic", "openai")


def chat_text(model, system, user, max_tokens=4000, on_delta=None,
              image_b64=""):
    """Simple single-turn text call (no tools). Returns (text, reasoning).

    Auto-continues once if the reply was cut off at max_tokens. Falls over to
    AGENT_FALLBACK_MODEL if the primary provider fails after retries.
    image_b64: optional PNG to attach (dropped for non-vision providers).
    """
    def _msgs(for_model):
        m = {"role": "user", "content": user}
        if image_b64 and _vision_capable(for_model):
            m["image_b64"] = image_b64
        return [m]

    messages = _msgs(model)
    used = model  # track the model that actually served the response
    try:
        r = chat(model, system, messages, max_tokens=max_tokens, on_delta=on_delta)
    except Exception:
        fb = (os.environ.get("AGENT_FALLBACK_MODEL") or "").strip()
        if not fb or fb == model:
            raise
        messages = _msgs(fb)
        r = chat(fb, system, messages, max_tokens=max_tokens, on_delta=on_delta)
        used = fb
    text, reasoning = r["text"], r["reasoning"]
    if r["stop"] == "max_tokens":
        messages.append({"role": "assistant", "content": text})
        messages.append({"role": "user", "content":
                         "Continue exactly where you left off. Do not repeat anything."})
        # Continue with the model that produced this reply (not the primary that
        # may have just failed) — else the continuation raises and discards the
        # good partial answer, or splices a different model's text.
        try:
            r2 = chat(used, system, messages, max_tokens=max_tokens, on_delta=on_delta)
            text += r2["text"]
            reasoning += r2["reasoning"]
        except Exception:
            pass  # keep the partial answer we already have
    return text, reasoning
