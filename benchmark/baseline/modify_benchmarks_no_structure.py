"""
Modify all baseline benchmark.py files to use log_format="<Content>"
so that parsers treat the entire log line as content without structural parsing.
"""

import ast
import re
from pathlib import Path

BASELINE_REPO = Path(__file__).parent / "logparser" / "logparser"

# List of parser directories to modify
PARSERS = ["Drain", "Spell", "IPLoM", "SLCT", "LenMa", "LogMine"]

def modify_benchmark_file(benchmark_path):
    """
    Replace all log_format values in benchmark_settings with "<Content>"
    and replace all regex values with []
    """
    if not benchmark_path.exists():
        print(f"[skip] {benchmark_path} does not exist")
        return

    print(f"[modify] {benchmark_path}")
    content = benchmark_path.read_text(encoding="utf-8")

    # Use regex to replace log_format values
    # Match: "log_format": "any value here",
    pattern_format = r'("log_format"\s*:\s*)"[^"]*"'
    replacement_format = r'\1"<Content>"'
    modified = re.sub(pattern_format, replacement_format, content)

    # Replace regex values with empty list
    # Match: "regex": [...], (including multiline arrays)
    pattern_regex = r'"regex"\s*:\s*\[(?:[^\[\]]|\[[^\]]*\])*\]'
    replacement_regex = r'"regex": []'
    modified = re.sub(pattern_regex, replacement_regex, modified, flags=re.DOTALL)

    # Backup original
    backup_path = benchmark_path.with_suffix('.py.backup')
    if not backup_path.exists():
        # Restore from backup first if it exists
        if backup_path.exists():
            content_backup = backup_path.read_text(encoding="utf-8")
            benchmark_path.write_text(content_backup, encoding="utf-8")
        benchmark_path.rename(backup_path)
        print(f"  [backup] created {backup_path.name}")

    # Write modified version
    Path(benchmark_path).write_text(modified, encoding="utf-8")
    print(f"  [done] log_format set to '<Content>', regex set to []")


def main():
    print("Modifying baseline benchmark.py files to disable structural parsing...\n")

    for parser in PARSERS:
        benchmark_path = BASELINE_REPO / parser / "benchmark.py"
        modify_benchmark_file(benchmark_path)
        print()

    print("=" * 60)
    print("All benchmark files modified!")
    print("To restore originals, rename .backup files back to .py")


if __name__ == "__main__":
    main()
