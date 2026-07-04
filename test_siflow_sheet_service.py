import tempfile
import unittest
from pathlib import Path

from siflow_sheet_service import (
    SheetAppender,
    build_sheet_row,
    build_backfill_payload,
    csv_for_row,
    find_next_row,
    parse_inline_annotations,
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

    def test_parse_inline_annotations_extracts_label_and_note(self):
        text = (
            "有严重问题，方案不可取。羽绒的主要成分是羽毛蛋白（角蛋白），"
            "长期或高温干燥会导致蛋白质发生热降解、变性、交联甚至碳化，"
            "【R-FACT-1：事实错误】【R-FACT-1-P0：家用烘干机高温档通常不超过80°C】"
            "使纤维变脆。"
        )

        annotations = parse_inline_annotations(text, "A")

        self.assertEqual(len(annotations), 1)
        self.assertEqual(annotations[0]["field"], "A")
        self.assertEqual(annotations[0]["tag_code"], "R-FACT-1")
        self.assertEqual(annotations[0]["tag_text"], "R-FACT-1：事实错误")
        self.assertEqual(annotations[0]["note"], "【R-FACT-1-P0：家用烘干机高温档通常不超过80°C】")
        self.assertEqual(
            annotations[0]["target_text"],
            "羽绒的主要成分是羽毛蛋白（角蛋白），长期或高温干燥会导致蛋白质发生热降解、变性、交联甚至碳化",
        )

    def test_parse_inline_annotations_handles_good_tag_without_note(self):
        text = "因此，恢复羽绒靠的是低温烘干和机械拍打。【C-R-03-逻辑严谨-因果链清楚】"

        annotations = parse_inline_annotations(text, "C")

        self.assertEqual(annotations[0]["tag_code"], "C-R-03")
        self.assertEqual(annotations[0]["note"], "")
        self.assertEqual(annotations[0]["target_text"], "因此，恢复羽绒靠的是低温烘干和机械拍打")

    def test_build_backfill_payload_maps_columns_and_annotations(self):
        row_values = {
            "A": "prompt",
            "B": "答案A【R-FACT-1：事实错误】【R-FACT-1-P0：备注】",
            "C": "2",
            "D": "A理由",
            "E": "答案B",
            "F": "3",
            "G": "B理由",
            "H": "答案C【C-R-03：逻辑严谨】",
            "I": "4",
            "J": "C理由",
            "K": "无",
        }

        payload = build_backfill_payload(12, row_values)

        self.assertEqual(payload["row_number"], 12)
        self.assertEqual(payload["answers"]["A"]["score"], "2")
        self.assertEqual(payload["answers"]["B"]["reason"], "B理由")
        self.assertEqual(payload["answers"]["D"]["text"], "无")
        self.assertEqual([a["tag_code"] for a in payload["annotations"]], ["R-FACT-1", "C-R-03"])


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
