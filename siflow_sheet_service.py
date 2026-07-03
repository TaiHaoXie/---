#!/usr/bin/env python3
import argparse
import csv
import html
import io
import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_SPREADSHEET_TOKEN = "QjQfsbWPGhS5Mdt8lrLck3WDnEh"
DEFAULT_SHEET_ID = "0aGjtg"
DEFAULT_READ_RANGE = "A1:L5000"
REQUIRED_FIELDS = ["prompt", "A", "B", "C", "D"]


def strip_char_count(value: Any) -> str:
    text = str(value or "").replace("\r", "").strip()
    return re.sub(r"(?:\n|\s)+\d+\s*字\s*$", "", text).strip()


def build_sheet_row(data: Dict[str, Any]) -> List[str]:
    """Build columns A-L for: prompt | A | score | reason | B | ... | D | E."""
    return [
        strip_char_count(data.get("prompt", "")),
        strip_char_count(data.get("A", "")),
        "",
        "",
        strip_char_count(data.get("B", "")),
        "",
        "",
        strip_char_count(data.get("C", "")),
        "",
        "",
        strip_char_count(data.get("D", "")),
        "",
    ]


def csv_for_row(row: List[str]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(row)
    return buffer.getvalue()


def validate_payload(data: Dict[str, Any]) -> List[str]:
    return [field for field in REQUIRED_FIELDS if not strip_char_count(data.get(field, ""))]


def find_next_row(lark_output: Dict[str, Any]) -> int:
    rows = lark_output.get("data", {}).get("rows", []) or []
    last_non_empty = 1

    for row in rows:
        row_number = int(row.get("row_number") or 0)
        values = row.get("values") or {}
        has_value = any(str(values.get(col, "") or "").strip() for col in "ABCDEFGHIJKL")
        if has_value:
            last_non_empty = max(last_non_empty, row_number)

    return max(last_non_empty + 1, 2)


def extract_json(stdout: str) -> Dict[str, Any]:
    text = stdout.strip()
    if not text:
        raise ValueError("empty lark-cli output")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise


def run_lark(args: List[str], stdin: Optional[str] = None) -> Dict[str, Any]:
    proc = subprocess.run(
        ["lark-cli", *args],
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            json.dumps(
                {
                    "returncode": proc.returncode,
                    "stdout": proc.stdout[-2000:],
                    "stderr": proc.stderr[-2000:],
                },
                ensure_ascii=False,
            )
        )
    return extract_json(proc.stdout)


class SheetAppender:
    def __init__(
        self,
        spreadsheet_token: str,
        sheet_id: str,
        read_range: str,
        log_path: Path,
        state_path: Optional[Path] = None,
        dry_run: bool = False,
    ) -> None:
        self.spreadsheet_token = spreadsheet_token
        self.sheet_id = sheet_id
        self.read_range = read_range
        self.log_path = Path(log_path)
        self.state_path = Path(state_path) if state_path else self.log_path.with_name(".siflow_service_state.json")
        self.dry_run = dry_run

    def read_state(self) -> Dict[str, Any]:
        if not self.state_path.exists():
            return {"manual_next_row": None}
        try:
            with self.state_path.open("r", encoding="utf-8") as file:
                state = json.load(file)
        except (OSError, json.JSONDecodeError):
            return {"manual_next_row": None}
        if not isinstance(state, dict):
            return {"manual_next_row": None}
        return {"manual_next_row": state.get("manual_next_row")}

    def write_state(self, state: Dict[str, Any]) -> None:
        normalized = {"manual_next_row": state.get("manual_next_row")}
        with self.state_path.open("w", encoding="utf-8") as file:
            json.dump(normalized, file, ensure_ascii=False, indent=2)

    def get_manual_next_row(self) -> Optional[int]:
        value = self.read_state().get("manual_next_row")
        if value in (None, ""):
            return None
        try:
            row = int(value)
        except (TypeError, ValueError):
            return None
        return row if row >= 2 else None

    def set_manual_next_row(self, row: Optional[int]) -> None:
        if row is None:
            self.write_state({"manual_next_row": None})
            return
        if int(row) < 2:
            raise ValueError("row must be >= 2")
        self.write_state({"manual_next_row": int(row)})

    def recent_logs(self, limit: int = 20) -> List[Dict[str, Any]]:
        if not self.log_path.exists():
            return []
        items: List[Dict[str, Any]] = []
        with self.log_path.open("r", encoding="utf-8") as file:
            for line in file:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                items.append({
                    "page_url": item.get("page_url", ""),
                    "row_number": item.get("row_number", ""),
                    "row_source": item.get("row_source", ""),
                })
        return items[-limit:][::-1]

    def clear_logs(self) -> None:
        self.log_path.write_text("", encoding="utf-8")

    def control_state(self) -> Dict[str, Any]:
        manual_next_row = self.get_manual_next_row()
        return {
            "ok": True,
            "dry_run": self.dry_run,
            "mode": "manual" if manual_next_row else "auto",
            "manual_next_row": manual_next_row,
            "target": {
                "spreadsheet_token": self.spreadsheet_token,
                "sheet_id": self.sheet_id,
                "read_range": self.read_range,
            },
            "recent": self.recent_logs(),
        }

    def get_next_row(self) -> int:
        output = run_lark(
            [
                "sheets",
                "+csv-get",
                "--spreadsheet-token",
                self.spreadsheet_token,
                "--sheet-id",
                self.sheet_id,
                "--range",
                self.read_range,
                "--rows-json",
                "--format",
                "json",
            ]
        )
        return find_next_row(output)

    def find_written(self, page_url: str) -> Optional[Dict[str, Any]]:
        if not page_url or not self.log_path.exists():
            return None

        with self.log_path.open("r", encoding="utf-8") as file:
            for line in file:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get("page_url") == page_url:
                    return item
        return None

    def log_written(self, entry: Dict[str, Any]) -> None:
        with self.log_path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def write_row(self, row_number: int, row: List[str]) -> Dict[str, Any]:
        return run_lark(
            [
                "sheets",
                "+csv-put",
                "--spreadsheet-token",
                self.spreadsheet_token,
                "--sheet-id",
                self.sheet_id,
                "--start-cell",
                f"A{row_number}",
                "--allow-overwrite=true",
                "--csv",
                "-",
                "--format",
                "json",
            ],
            stdin=csv_for_row(row),
        )

    def append(self, payload: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        page_url = str(payload.get("page_url", "") or "").split("#", 1)[0]

        missing = validate_payload(payload)
        if missing:
            raise ValueError("missing fields: " + ", ".join(missing))

        row = build_sheet_row(payload)
        if self.dry_run:
            return "dry_run", {
                "page_url": page_url,
                "row_number": self.get_manual_next_row() or 0,
                "row": row,
                "csv": csv_for_row(row),
                "fields": {field: payload.get(field, "") for field in REQUIRED_FIELDS},
            }

        manual_row = self.get_manual_next_row()
        row_number = manual_row or self.get_next_row()
        result = self.write_row(row_number, row)
        if manual_row:
            self.set_manual_next_row(row_number + 1)

        entry = {
            "page_url": page_url,
            "row_number": row_number,
            "row_source": "manual" if manual_row else "auto",
            "fields": {field: payload.get(field, "") for field in REQUIRED_FIELDS},
            "lark_result": result.get("data", result),
        }
        self.log_written(entry)
        return "appended", entry


def dashboard_html(appender: SheetAppender) -> str:
    state = appender.control_state()
    recent_rows = "\n".join(
        "<tr>"
        f"<td>{html.escape(str(item.get('row_number', '')))}</td>"
        f"<td>{html.escape(str(item.get('row_source', '')))}</td>"
        f"<td>{html.escape(str(item.get('page_url', ''))[:120])}</td>"
        "</tr>"
        for item in state["recent"]
    )
    if not recent_rows:
        recent_rows = '<tr><td colspan="3" class="muted">暂无写入记录</td></tr>'

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Siflow 写表控制台</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #0f172a; }}
    .card {{ max-width: 920px; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; box-shadow: 0 2px 12px #0000000d; }}
    h1 {{ margin: 0 0 12px; font-size: 24px; }}
    label {{ display: block; margin: 16px 0 8px; font-weight: 600; }}
    input {{ width: 180px; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 15px; }}
    button {{ padding: 8px 12px; border: 0; border-radius: 8px; background: #1677ff; color: white; font-weight: 600; cursor: pointer; margin-left: 8px; }}
    button.secondary {{ background: #64748b; }}
    code {{ background: #f1f5f9; padding: 2px 5px; border-radius: 4px; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 14px; }}
    th, td {{ border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }}
    .muted {{ color: #64748b; }}
    .ok {{ color: #16a34a; font-weight: 700; }}
    .warn {{ color: #f59e0b; font-weight: 700; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>Siflow 写表控制台</h1>
    <p>服务状态：<span class="ok">运行中</span> {'<span class="warn">Dry Run，不会写表</span>' if state['dry_run'] else ''}</p>
    <p>目标：<code>{html.escape(appender.spreadsheet_token)}</code> / sheet <code>{html.escape(appender.sheet_id)}</code></p>
    <p>当前模式：<strong id="mode">{'从指定行连续写入' if state['manual_next_row'] else '自动找下一空行'}</strong></p>

    <label for="nextRow">下一次写入行号</label>
    <input id="nextRow" type="number" min="2" placeholder="留空=自动追加" value="{state['manual_next_row'] or ''}">
    <button onclick="saveRow()">跳到此行号</button>
    <button class="secondary" onclick="clearRow()">改回自动找空行</button>
    <p id="message" class="muted">比如填 20：下一次 F8 写第 20 行，成功后这里会自动变成 21。</p>

    <h2>最近写入</h2>
    <button class="secondary" onclick="clearRecent()" style="margin-left:0;">清空最近写入</button>
    <table>
      <thead><tr><th>行号</th><th>来源</th><th>页面</th></tr></thead>
      <tbody id="recent">{recent_rows}</tbody>
    </table>
  </div>
  <script>
    function htmlEscape(value) {{
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }}
    function renderRecent(items) {{
      const body = document.getElementById('recent');
      if (!items || !items.length) {{
        body.innerHTML = '<tr><td colspan="3" class="muted">暂无写入记录</td></tr>';
        return;
      }}
      body.innerHTML = items.map(item => `
        <tr>
          <td>${{htmlEscape(item.row_number)}}</td>
          <td>${{htmlEscape(item.row_source)}}</td>
          <td>${{htmlEscape(String(item.page_url || '').slice(0, 120))}}</td>
        </tr>
      `).join('');
    }}
    function renderState(data) {{
      document.getElementById('mode').textContent = data.manual_next_row ? '从指定行连续写入' : '自动找下一空行';
      document.getElementById('nextRow').value = data.manual_next_row || '';
      renderRecent(data.recent || []);
    }}
    async function refreshState() {{
      try {{
        const res = await fetch('/api/state');
        const data = await res.json();
        if (data.ok) renderState(data);
      }} catch (e) {{}}
    }}
    async function saveRow() {{
      const value = document.getElementById('nextRow').value.trim();
      if (!value) return clearRow();
      const row = Number(value);
      if (!Number.isInteger(row) || row < 2) {{
        document.getElementById('message').textContent = '行号必须是 >= 2 的整数';
        return;
      }}
      const res = await fetch('/api/state', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ manual_next_row: row }})
      }});
      const data = await res.json();
      document.getElementById('message').textContent = data.ok ? ('已设置：下一次写第 ' + data.manual_next_row + ' 行') : data.error;
      if (data.ok) renderState(data);
    }}
    async function clearRow() {{
      const res = await fetch('/api/state', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ manual_next_row: null }})
      }});
      const data = await res.json();
      document.getElementById('nextRow').value = '';
      document.getElementById('message').textContent = data.ok ? '已改回自动找下一空行' : data.error;
      if (data.ok) renderState(data);
    }}
    async function clearRecent() {{
      if (!confirm('确认清空最近写入记录？这只清空本地日志，不会改飞书表格。')) return;
      const res = await fetch('/api/logs/clear', {{ method: 'POST' }});
      const data = await res.json();
      document.getElementById('message').textContent = data.ok ? '已清空最近写入记录' : data.error;
      if (data.ok) renderState(data);
    }}
    setInterval(refreshState, 1500);
    refreshState();
  </script>
</body>
</html>"""


class AppendHandler(BaseHTTPRequestHandler):
    appender: SheetAppender

    def log_message(self, format: str, *args: Any) -> None:
        print("[http]", format % args)

    def _headers(self, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json(self, status: int, data: Dict[str, Any]) -> None:
        self._headers(status)
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _html(self, status: int, content: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))

    def do_OPTIONS(self) -> None:
        self._headers(204)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self._html(200, dashboard_html(self.appender))
            return
        if path == "/api/state":
            self._json(200, self.appender.control_state())
            return
        if path.startswith("/health"):
            self._json(200, {"ok": True, "service": "siflow-sheet-service"})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/state":
            try:
                length = int(self.headers.get("Content-Length") or "0")
                body = self.rfile.read(length).decode("utf-8")
                payload = json.loads(body or "{}")
                value = payload.get("manual_next_row")
                self.appender.set_manual_next_row(None if value in (None, "") else int(value))
                self._json(200, self.appender.control_state())
            except ValueError as exc:
                self._json(400, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self._json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/logs/clear":
            try:
                self.appender.clear_logs()
                self._json(200, self.appender.control_state())
            except Exception as exc:
                self._json(500, {"ok": False, "error": str(exc)})
            return

        if path != "/append":
            self._json(404, {"ok": False, "error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(body or "{}")
            status, entry = self.appender.append(payload)
            self._json(200, {"ok": True, "status": status, **entry})
        except ValueError as exc:
            self._json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self._json(500, {"ok": False, "error": str(exc)})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Append Siflow prompt/A/B/C/D to a Lark sheet.")
    parser.add_argument("--host", default=os.getenv("SIFLOW_SERVICE_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.getenv("SIFLOW_SERVICE_PORT", DEFAULT_PORT)))
    parser.add_argument("--spreadsheet-token", default=os.getenv("SIFLOW_SPREADSHEET_TOKEN", DEFAULT_SPREADSHEET_TOKEN))
    parser.add_argument("--sheet-id", default=os.getenv("SIFLOW_SHEET_ID", DEFAULT_SHEET_ID))
    parser.add_argument("--read-range", default=os.getenv("SIFLOW_READ_RANGE", DEFAULT_READ_RANGE))
    parser.add_argument(
        "--log-path",
        default=os.getenv("SIFLOW_WRITTEN_LOG", str(Path(__file__).with_name(".siflow_written_log.jsonl"))),
    )
    parser.add_argument(
        "--state-path",
        default=os.getenv("SIFLOW_STATE_PATH", str(Path(__file__).with_name(".siflow_service_state.json"))),
    )
    parser.add_argument("--dry-run", action="store_true", help="Do not write to Lark; return extracted row preview only.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    AppendHandler.appender = SheetAppender(
        spreadsheet_token=args.spreadsheet_token,
        sheet_id=args.sheet_id,
        read_range=args.read_range,
        log_path=Path(args.log_path),
        state_path=Path(args.state_path),
        dry_run=args.dry_run,
    )

    server = ThreadingHTTPServer((args.host, args.port), AppendHandler)
    print(f"Siflow sheet service listening on http://{args.host}:{args.port}")
    print(f"Dashboard: http://{args.host}:{args.port}/")
    print(f"Target sheet token={args.spreadsheet_token}, sheet_id={args.sheet_id}")
    if args.dry_run:
        print("DRY RUN MODE: no data will be written to Lark.")
    print("Keep this terminal open. Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
