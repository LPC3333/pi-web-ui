#!/usr/bin/env bash
# Pi Web UI 快速重启脚本

echo "=== 停止旧进程 ==="
for port in 3001 5173; do
  pid=$(netstat -ano 2>/dev/null | grep ":$port" | grep LISTENING | awk '{print $5}' | head -1)
  if [ -n "$pid" ]; then
    taskkill //PID $pid //F 2>/dev/null && echo "  已停止端口 $port (PID $pid)"
  fi
done
sleep 1

echo "=== 启动后端 ==="
cd "F:/pi-web-ui"
nohup npx tsx server/index.ts > /tmp/pi-server.log 2>&1 &
echo "  后端 PID: $!"

echo "=== 启动前端 ==="
cd "F:/pi-web-ui/client"
nohup npx vite --host --force > /tmp/vite.log 2>&1 &
echo "  前端 PID: $!"

sleep 4
echo "=== 验证 ==="
curl -s --noproxy "*" http://localhost:3001/api/health > /dev/null 2>&1 && echo "  后端 :3001 ✓"
curl -s --noproxy "*" http://localhost:5173/api/health > /dev/null 2>&1 && echo "  前端 :5173 ✓"

echo ""
echo "打开 http://localhost:5173"
