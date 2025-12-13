import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
import ast

import pandas as pd

# Resolve paths using this file location (CWD independent)
SCRIPT_DIR = Path(__file__).resolve().parent  # baseline/
DATASETS_ROOT = SCRIPT_DIR / ".." / "datasets"
BASELINE_PKG_ROOT = SCRIPT_DIR
BASELINE_REPO = SCRIPT_DIR / "logparser"
OUTPUT_ROOT = SCRIPT_DIR / "output"
RESULTS_ROOT = SCRIPT_DIR / "results"
TOOLCHAIN_BIN = SCRIPT_DIR / ".." / "toolchains" / "winlibs" / "mingw64" / "bin"

# Prepend toolchain bin to PATH so SLCT compilation can find gcc.
if TOOLCHAIN_BIN.exists():
    os.environ["PATH"] = str(TOOLCHAIN_BIN) + os.pathsep + os.environ.get("PATH", "")

# Make upstream baselines importable (package path: logparser.logparser.*)
sys.path.append(str(BASELINE_PKG_ROOT))

from logparser.logparser.Drain import LogParser as DrainParser
from logparser.logparser.Spell import LogParser as SpellParser
from logparser.logparser.IPLoM import LogParser as IPLoMParser
# from logparser.logparser.SLCT import LogParser as SLCTParser  # Disabled: cannot run
from logparser.logparser.LenMa import LogParser as LenMaParser
from logparser.logparser.LogMine import LogParser as LogMineParser


def load_benchmark_settings(py_path):
    """Parse benchmark_settings dict from the given file without executing top-level code."""
    text = Path(py_path).read_text(encoding="utf-8")
    tree = ast.parse(text)
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "benchmark_settings":
                    return ast.literal_eval(node.value)
    raise ValueError(f"benchmark_settings not found in {py_path}")


def accuracy_metrics(truth, pred):
    """Pairwise F1 (GA) and perfect-cluster accuracy (PA)."""
    comb2 = lambda n: 0 if n < 2 else n * (n - 1) // 2

    truth_counts = Counter(truth)
    real_pairs = sum(comb2(c) for c in truth_counts.values())

    pred_counts = Counter(pred)
    parsed_pairs = sum(comb2(c) for c in pred_counts.values())

    idx_by_pred = {}
    for idx, pid in enumerate(pred):
        idx_by_pred.setdefault(pid, []).append(idx)

    accurate_pairs = 0
    accurate_events = 0
    for pid, idxs in idx_by_pred.items():
        gt_counts = Counter(truth[i] for i in idxs)
        if len(gt_counts) == 1:
            gt_id = next(iter(gt_counts))
            if len(idxs) == truth_counts.get(gt_id, 0):
                accurate_events += len(idxs)
        accurate_pairs += sum(comb2(c) for c in gt_counts.values())

    precision = 0 if parsed_pairs == 0 else accurate_pairs / parsed_pairs
    recall = 0 if real_pairs == 0 else accurate_pairs / real_pairs
    f1 = 0 if precision == 0 and recall == 0 else 2 * precision * recall / (precision + recall)
    accuracy = 0 if len(truth) == 0 else accurate_events / len(truth)
    return {"GA": f1, "GA_precision": precision, "GA_recall": recall, "PA": accuracy}


def purity_metric(base_ids, other_ids):
    """Weighted dominant-ratio per base cluster."""
    base_to_other = {}
    for b, o in zip(base_ids, other_ids):
        counts = base_to_other.setdefault(b, Counter())
        counts[o] += 1
    top_sum = 0
    total_sum = 0
    for counts in base_to_other.values():
        total = sum(counts.values())
        top = max(counts.values()) if counts else 0
        total_sum += total
        top_sum += top
    return 0 if total_sum == 0 else top_sum / total_sum


def collapse_pure_clusters(truth, pred):
    """Merge over-split pure clusters into one cluster per GT id."""
    gt_by_pred = {}
    for p, t in zip(pred, truth):
        s = gt_by_pred.setdefault(p, set())
        s.add(t)

    mapping = {}
    pure_mask = []
    for p in pred:
        gts = gt_by_pred.get(p, set())
        if len(gts) == 1:
            only_gt = next(iter(gts))
            mapping[p] = f"__PURE__#{only_gt}"
            pure_mask.append(True)
        else:
            mapping[p] = p
            pure_mask.append(False)

    merged_pred = [mapping[p] for p in pred]
    pure_coverage = 0 if len(pred) == 0 else sum(pure_mask) / len(pred)
    return merged_pred, pure_coverage


def load_event_ids(csv_path):
    df = pd.read_csv(csv_path)
    for col in ["EventId", "EventID", "eventId", "eventid"]:
        if col in df.columns:
            return df[col].fillna("").astype(str).tolist()
    raise ValueError(f"No EventId column found in {csv_path}")


def get_ground_truth(dataset_dir):
    candidates = sorted(
        [
            p
            for p in dataset_dir.glob("*.csv")
            if p.name.endswith("_structured_corrected.csv") or p.name.endswith("_structured.csv")
        ],
        key=lambda p: ("corrected" not in p.name, p.name),
    )
    if not candidates:
        raise FileNotFoundError(f"No structured ground-truth CSV in {dataset_dir}")
    return candidates[0]


def run_parser(method, setting, parser_cls, extra_kwargs, dataset, dataset_dir):
    log_path = dataset_dir / os.path.basename(setting["log_file"])
    out_dir = OUTPUT_ROOT / method / dataset
    out_dir.mkdir(parents=True, exist_ok=True)

    parser = parser_cls(
        log_format=setting["log_format"],
        indir=str(log_path.parent),
        outdir=str(out_dir),
        **extra_kwargs(setting),
    )
    parser.parse(log_path.name)
    return out_dir / f"{log_path.name}_structured.csv"


def run_all(datasets, methods):
    # Map method name to (benchmark_settings, parser_class, kwargs_mapper)
    base = BASELINE_REPO / "logparser"
    drain_settings = load_benchmark_settings(base / "Drain" / "benchmark.py")
    spell_settings = load_benchmark_settings(base / "Spell" / "benchmark.py")
    iplom_settings = load_benchmark_settings(base / "IPLoM" / "benchmark.py")
    # slct_settings = load_benchmark_settings(base / "SLCT" / "benchmark.py")  # Disabled
    lenma_settings = load_benchmark_settings(base / "LenMa" / "benchmark.py")
    logmine_settings = load_benchmark_settings(base / "LogMine" / "benchmark.py")
    runners = {
        "Drain": (
            drain_settings,
            DrainParser,
            lambda s: {"rex": s.get("regex", []), "depth": s.get("depth", 4), "st": s.get("st", 0.5)},
        ),
        "Spell": (
            spell_settings,
            SpellParser,
            lambda s: {"rex": s.get("regex", []), "tau": s.get("tau", 0.5)},
        ),
        "IPLoM": (
            iplom_settings,
            IPLoMParser,
            lambda s: {"rex": s.get("regex", []), "CT": s.get("CT", 0.35), "lowerBound": s.get("lowerBound", 0.25)},
        ),
        # "SLCT": (  # Disabled: cannot run
        #     slct_settings,
        #     SLCTParser,
        #     lambda s: {"rex": s.get("regex", []), "support": s.get("support", 10)},
        # ),
        "LenMa": (
            lenma_settings,
            LenMaParser,
            lambda s: {"rex": s.get("regex", []), "threshold": s.get("threshold", 0.7)},
        ),
        "LogMine": (
            logmine_settings,
            LogMineParser,
            lambda s: {
                "rex": s.get("regex", []),
                "max_dist": s.get("max_dist", 0.002),
                "k": s.get("k", 1),
                "levels": s.get("levels", 2),
            },
        ),
    }

    results = []
    for method in methods:
        if method not in runners:
            print(f"[skip] Unknown method {method}")
            continue
        bench_settings, parser_cls, kw_mapper = runners[method]
        for dataset in datasets:
            setting = bench_settings.get(dataset)
            dataset_dir = DATASETS_ROOT / dataset
            if setting is None:
                print(f"[skip] {method} has no benchmark setting for {dataset}")
                continue
            if not dataset_dir.exists():
                print(f"[skip] dataset folder missing: {dataset_dir}")
                continue
            try:
                pred_csv = run_parser(method, setting, parser_cls, kw_mapper, dataset, dataset_dir)
                gt_csv = get_ground_truth(dataset_dir)
                truth = load_event_ids(gt_csv)
                pred = load_event_ids(pred_csv)
                if len(truth) != len(pred):
                    raise ValueError(f"Length mismatch truth={len(truth)} pred={len(pred)}")
                metrics = accuracy_metrics(truth, pred)
                metrics["predPure"] = purity_metric(pred, truth)
                metrics["gtPure"] = purity_metric(truth, pred)
                friendly_pred, pure_cov = collapse_pure_clusters(truth, pred)
                friendly = accuracy_metrics(truth, friendly_pred)
                metrics["GA_friendly"] = friendly["GA"]
                metrics["GA_friendly_precision"] = friendly["GA_precision"]
                metrics["GA_friendly_recall"] = friendly["GA_recall"]
                metrics["PA_friendly"] = friendly["PA"]
                metrics["pureCoverage"] = pure_cov
                results.append(
                    {
                        "method": method,
                        "dataset": dataset,
                        **metrics,
                        "pred_file": str(pred_csv),
                        "gt_file": str(gt_csv),
                    }
                )
                print(
                    f"[ok] {method}/{dataset}: GA={metrics['GA']:.3f} "
                    f"(P={metrics['GA_precision']:.3f}, R={metrics['GA_recall']:.3f}) "
                    f"PA={metrics['PA']:.3f}"
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[fail] {method}/{dataset}: {exc}")
                results.append({"method": method, "dataset": dataset, "error": str(exc)})
    return results


def save_results(results):
    ts = datetime.utcnow().isoformat().replace(":", "-").replace(".", "-")
    run_dir = RESULTS_ROOT / ts
    run_dir.mkdir(parents=True, exist_ok=True)
    json_path = run_dir / "baseline-metrics.json"
    csv_path = run_dir / "baseline-metrics.csv"
    pd.DataFrame(results).to_csv(csv_path, index=False)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"generated_at": ts, "results": results}, f, ensure_ascii=False, indent=2)
    print(f"[write] {json_path}")
    print(f"[write] {csv_path}")
    return csv_path, run_dir


def load_ours_results():
    """Load latest evaluation results from evaluation/results/*.json and map to baseline schema."""
    eval_dir = Path("../evaluation/results").resolve()
    json_files = sorted(eval_dir.glob("*.json"))
    if not json_files:
        print("[warn] no evaluation results found for 'Ours'")
        return []
    latest = json_files[-1]
    try:
        data = json.loads(latest.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] failed to read {latest}: {exc}")
        return []
    datasets = data.get("datasets", [])
    results = []
    for r in datasets:
        if r.get("error"):
            continue
        results.append(
            {
                "method": "Ours",
                "dataset": r.get("dataset", ""),
                "GA": r.get("GA", 0),
                "GA_precision": r.get("GA_precision", 0),
                "GA_recall": r.get("GA_recall", 0),
                "PA": r.get("PA", 0),
                "GA_friendly": r.get("GA_friendly", 0),
                "GA_friendly_precision": r.get("GA_friendly_precision", 0),
                "GA_friendly_recall": r.get("GA_friendly_recall", 0),
                "PA_friendly": r.get("PA_friendly", 0),
                "predPure": r.get("predPurity", 0) or r.get("predPure", 0),
                "gtPure": r.get("gtPurity", 0) or r.get("gtPure", 0),
                "pureCoverage": r.get("pureCoverage", 0),
                "coverage": r.get("coverage", 0),
                "pred_file": "",
                "gt_file": "",
            }
        )
    print(f"[info] loaded Ours metrics from {latest.name}")
    return results


def plot_results(csv_path, methods, datasets):
    try:
        import matplotlib.pyplot as plt
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] matplotlib not available, skip plots: {exc}")
        return

    plt.rcParams.update({"font.family": "DejaVu Sans", "axes.unicode_minus": False})

    df = pd.read_csv(csv_path)
    df = df[df["error"].isna()] if "error" in df.columns else df
    if df.empty:
        print("[warn] no successful results to plot")
        return

    metrics_to_plot = [
        "GA",
        "PA",
        "GA_friendly",
        "PA_friendly",
        "predPure",
        "gtPure",
        "pureCoverage",
    ]

    for metric in metrics_to_plot:
        if metric not in df.columns:
            continue
        pivot = (
            df.pivot(index="dataset", columns="method", values=metric)
            .reindex(index=datasets, columns=methods)
        )
        pivot = pivot.dropna(how="all").fillna(0)
        ax = pivot.plot(
            kind="bar",
            figsize=(12, 7),
            title=f"{metric} by method",
            width=0.7,
        )
        ax.set_ylabel(metric)
        ax.set_xlabel("dataset")
        ax.legend(title="method", fontsize=9)
        ax.grid(True, axis="y", linestyle="--", alpha=0.3)
        for container in ax.containers:
            ax.bar_label(container, fmt="%.2f", fontsize=8, padding=2)
        plt.xticks(rotation=30, ha="right")
        ax.grid(True, axis="y", linestyle="--", alpha=0.3)
        plt.tight_layout()
        out_png = csv_path.parent / f"{metric}.png"
        plt.savefig(out_png, dpi=200)
        plt.close()
        print(f"[plot] {out_png}")


def main():
    parser = argparse.ArgumentParser(description="Run classic baselines and compare metrics.")
    parser.add_argument(
        "--methods",
        nargs="+",
        default=["Drain", "Spell", "IPLoM", "LenMa", "LogMine"],
        help="Baseline methods to run",
    )
    parser.add_argument(
        "--datasets",
        nargs="+",
        default=None,
        help="Datasets to run (default: all available from benchmark settings & datasets folder)",
    )
    parser.add_argument(
        "--include-ours",
        action="store_true",
        default=True,
        help="Include latest evaluation results from evaluation/results as method 'Ours'",
    )
    args = parser.parse_args()

    # Determine datasets to process: intersection of requested and existing
    available = sorted({p.name for p in DATASETS_ROOT.iterdir() if p.is_dir()})
    datasets = args.datasets if args.datasets else available
    results = run_all(datasets, args.methods)
    if args.include_ours:
        ours = load_ours_results()
        results.extend([r for r in ours if r.get("dataset") in datasets])
        if "Ours" not in args.methods:
            args.methods.append("Ours")
    csv_path, run_dir = save_results(results)
    plot_results(Path(csv_path), args.methods, datasets)


if __name__ == "__main__":
    main()
