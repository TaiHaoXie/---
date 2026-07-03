#!/bin/zsh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_PORT=8787
SERVICE_PID=""

print_line() {
  printf "\n%s\n" "$1"
}

wait_before_exit() {
  print_line "按回车关闭这个窗口。"
  read -r _
}

cleanup() {
  if [[ -n "$SERVICE_PID" ]] && kill -0 "$SERVICE_PID" 2>/dev/null; then
    kill "$SERVICE_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

cd "$SCRIPT_DIR" || {
  echo "找不到脚本目录：$SCRIPT_DIR"
  wait_before_exit
  exit 1
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "没找到 python3。"
  wait_before_exit
  exit 1
fi

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "没找到 lark-cli。先确认飞书 CLI 已安装并登录。"
  wait_before_exit
  exit 1
fi

if lsof -nP -iTCP:$SERVICE_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $SERVICE_PORT 已被占用。"
  echo "如果你之前已经开过写表服务，就先关掉那个终端窗口，再双击本文件。"
  wait_before_exit
  exit 1
fi

print_line "1/2 启动写表服务..."
python3 "$SCRIPT_DIR/siflow_sheet_service.py" &
SERVICE_PID=$!
sleep 1

if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
  echo "写表服务启动失败。"
  wait_before_exit
  exit 1
fi

print_line "2/2 打开写表控制台..."
open "http://127.0.0.1:${SERVICE_PORT}/"

print_line "已启动。"
echo "先在控制台页面设置下一次写入行号；不设置就是自动追加。"
echo "然后去标注页面，右下角点按钮或按 F8。"
echo "这次是正式写入：会写到飞书表格下一行。"
echo "不要关闭这个终端窗口；要停止时按 Ctrl+C。"

wait
