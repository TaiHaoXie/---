import tempfile
import unittest
from pathlib import Path

from siflow_sheet_service import (
    SheetAppender,
    build_sheet_row,
    csv_for_row,
    find_next_row,
    strip_char_count,
    validate_payload,
)


class SiflowSheetServiceTests(unittest.TestCase):
    def payload(self, page_url="https://example.test/case/1"):
        return {
            "prompt": "p",
            "A": "a",
            "B": "b",
            "C": "c",
            "D": "d",
            "page_url": page_url,
        }

    def test_build_sheet_row_inserts_empty_score_reason_columns(self):
        row = build_sheet_row({
            "prompt": "p",
            "A": "a",
            "B": "b",
            "C": "c",
            "D": "d",
        })

        self.assertEqual(
            row,
            ["p", "a", "", "", "b", "", "", "c", "", "", "d", ""],
        )

    def test_csv_for_row_preserves_tabs_newlines_and_quotes(self):
        row = build_sheet_row({
            "prompt": 'hello "x"\nnext',
            "A": "a",
            "B": "b",
            "C": "c",
            "D": "d",
        })

        csv_text = csv_for_row(row)

        self.assertTrue(csv_text.startswith('"hello ""x""\nnext",a,,,b,,,c,,,d,'))

    def test_find_next_row_uses_last_non_empty_row(self):
        lark_output = {
            "ok": True,
            "data": {
                "rows": [
                    {"row_number": 1, "values": {"A": "prompt", "B": "A"}},
                    {"row_number": 2, "values": {"A": "p1"}},
                    {"row_number": 3, "values": {"A": "", "B": ""}},
                    {"row_number": 4, "values": {"E": "b2"}},
                ]
            },
        }

        self.assertEqual(find_next_row(lark_output), 5)

    def test_find_next_row_starts_after_header_when_empty(self):
        lark_output = {"ok": True, "data": {"rows": []}}

        self.assertEqual(find_next_row(lark_output), 2)

    def test_validate_payload_reports_missing_fields(self):
        missing = validate_payload({"prompt": "p", "A": "a"})

        self.assertEqual(missing, ["B", "C", "D"])

    def test_dry_run_append_does_not_call_lark_and_returns_row_preview(self):
        appender = SheetAppender(
            spreadsheet_token="token",
            sheet_id="sheet",
            read_range="A1:L5000",
            log_path="/tmp/unused-siflow-log.jsonl",
            dry_run=True,
        )

        status, entry = appender.append(self.payload("file:///tmp/demo.html"))

        self.assertEqual(status, "dry_run")
        self.assertEqual(entry["row_number"], 0)
        self.assertEqual(entry["row"], ["p", "a", "", "", "b", "", "", "c", "", "", "d", ""])

    def test_strip_char_count_removes_trailing_count_only(self):
        self.assertEqual(strip_char_count("答案内容\n585 字"), "答案内容")
        self.assertEqual(strip_char_count("答案内容 1307字"), "答案内容")
        self.assertEqual(strip_char_count("正文里提到 585 字节"), "正文里提到 585 字节")

    def test_manual_next_row_is_used_and_incremented_after_successful_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            appender = FakeAppender(tmp)
            appender.set_manual_next_row(20)

            status, entry = appender.append(self.payload("https://example.test/case/20"))

            self.assertEqual(status, "appended")
            self.assertEqual(entry["row_number"], 20)
            self.assertEqual(appender.get_manual_next_row(), 21)
            self.assertEqual(appender.writes[0][0], 20)

    def test_same_page_can_be_written_again_and_overwrite_next_manual_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            appender = FakeAppender(tmp)
            appender.set_manual_next_row(3)

            first_status, first_entry = appender.append(self.payload("https://example.test/same"))
            second_status, second_entry = appender.append(self.payload("https://example.test/same"))

            self.assertEqual(first_status, "appended")
            self.assertEqual(second_status, "appended")
            self.assertEqual(first_entry["row_number"], 3)
            self.assertEqual(second_entry["row_number"], 4)
            self.assertEqual(appender.get_manual_next_row(), 5)

    def test_auto_mode_uses_detected_next_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            appender = FakeAppender(tmp)

            status, entry = appender.append(self.payload("https://example.test/case/auto"))

            self.assertEqual(status, "appended")
            self.assertEqual(entry["row_number"], 99)

    def test_recent_logs_are_summarized_and_clearable(self):
        with tempfile.TemporaryDirectory() as tmp:
            appender = FakeAppender(tmp)
            appender.log_written({
                "page_url": "https://example.test/case/1",
                "row_number": 10,
                "row_source": "manual",
                "fields": {"prompt": "x" * 1000},
            })

            recent = appender.recent_logs()

            self.assertEqual(recent, [{
                "page_url": "https://example.test/case/1",
                "row_number": 10,
                "row_source": "manual",
            }])

            appender.clear_logs()
            self.assertEqual(appender.recent_logs(), [])


class FakeAppender(SheetAppender):
    def __init__(self, tmp):
        super().__init__(
            spreadsheet_token="token",
            sheet_id="sheet",
            read_range="A1:L5000",
            log_path=Path(tmp) / "log.jsonl",
            state_path=Path(tmp) / "state.json",
        )
        self.writes = []

    def get_next_row(self):
        return 99

    def write_row(self, row_number, row):
        self.writes.append((row_number, row))
        return {"data": {"writes_range": f"A{row_number}:L{row_number}"}}


if __name__ == "__main__":
    unittest.main()
