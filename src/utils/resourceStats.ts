export type ResourceStats = {
  cpuPercent: number;
  memoryPercent: number;
};

const RESOURCE_STATS_COMMAND = `
uname_s="$(uname 2>/dev/null || echo unknown)"
if [ "$uname_s" = "Darwin" ]; then
  cpu="$(top -l 2 -n 0 | awk 'match($0, /([0-9.]+)% idle/, m) { idle=m[1] } END { if (idle == "") exit 1; printf "%d", 100 - idle + 0.5 }')"
  mem="$(memory_pressure 2>/dev/null | awk '/System-wide memory free percentage/ { free=$5; gsub(/%/, "", free); printf "%d", 100 - free; found=1 } END { if (!found) exit 1 }')"
else
  cpu="$(
    cpu_line_1="$(grep '^cpu ' /proc/stat 2>/dev/null)" || exit 1
    sleep 1
    cpu_line_2="$(grep '^cpu ' /proc/stat 2>/dev/null)" || exit 1
    printf '%s\n%s\n' "$cpu_line_1" "$cpu_line_2" | awk '
      NR == 1 {
        total1 = 0;
        for (i = 2; i <= NF; i++) total1 += $i;
        idle1 = $5;
      }
      NR == 2 {
        total2 = 0;
        for (i = 2; i <= NF; i++) total2 += $i;
        idle2 = $5;
        total = total2 - total1;
        idle = idle2 - idle1;
        if (total <= 0) exit 1;
        printf "%d", ((total - idle) * 100) / total;
      }
    '
  )"
  mem="$(awk '/MemTotal:/ { t=$2 } /MemAvailable:/ { a=$2 } END { if (t > 0 && a > 0) { printf "%d", ((t-a)*100)/t; found=1 } } END { if (!found) exit 1 }' /proc/meminfo 2>/dev/null)" || mem="$(free 2>/dev/null | awk '/^Mem:/ { if ($2 <= 0) exit 1; printf "%d", ($3 * 100) / $2 }')"
fi
printf "CPU=%s\\nMEM=%s\\n" "$cpu" "$mem"
`.trim();

export function getResourceStatsCommand(): string {
  return RESOURCE_STATS_COMMAND;
}

export function parseResourceStatsOutput(stdout: string): ResourceStats | null {
  if (!stdout) return null;
  const cpuMatch = stdout.match(/CPU=(\d{1,3})/);
  const memoryMatch = stdout.match(/MEM=(\d{1,3})/);
  if (!cpuMatch || !memoryMatch) return null;

  const cpuPercent = Number(cpuMatch[1]);
  const memoryPercent = Number(memoryMatch[1]);
  if (!Number.isFinite(cpuPercent) || !Number.isFinite(memoryPercent)) return null;
  if (cpuPercent < 0 || cpuPercent > 100 || memoryPercent < 0 || memoryPercent > 100) {
    return null;
  }

  return { cpuPercent, memoryPercent };
}
