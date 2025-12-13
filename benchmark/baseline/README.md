Downloaded baselines
====================

I fetched the official `logpai/logparser` repository (depth 1) into `baseline/logparser`. It includes classic parsers such as Drain, Spell, IPLoM, AEL, Lenma, LFA, SLCT, and LogMine.

Quick start
- Create a Python 3 environment with the requirements in `baseline/logparser/requirements.txt`.
- For usage and per-parser scripts, see `baseline/logparser/README.md` and the `demo/` and `*Demo.py` files in that repo.
- Point the scripts to your datasets under `datasets/` and adjust output paths as needed for evaluation.
- The helper script `baseline/run_and_compare.py` runs several classic parsers (Drain, Spell, IPLoM, SLCT, LenMa, LogMine) on the local `datasets/`, evaluates GA/PA against ground truth, and writes CSV/JSON + bar charts.

Notes
- Repo is unmodified from upstream (depth=1 clone). Update with `git pull` inside `baseline/logparser` if needed.
- You need `matplotlib` for plots (`pip install matplotlib`).

Run everything (after `pip install -r baseline/logparser/requirements.txt`):
```bash
python baseline/run_and_compare.py
# or select methods / datasets
python baseline/run_and_compare.py --methods Drain Spell --datasets HDFS BGL
```
