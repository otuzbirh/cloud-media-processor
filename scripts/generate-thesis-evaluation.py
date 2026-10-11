#!/usr/bin/env python3
"""Generate thesis-ready tables and figures from the strict experiment analysis."""

from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont


POLICIES = ["STATIC", "CPU_HPA", "QUEUE_KEDA"]
SCENARIOS = ["low", "high", "ramp", "spike"]
POLICY_LABELS = {
    "STATIC": "S0 Statička",
    "CPU_HPA": "S1 CPU HPA",
    "QUEUE_KEDA": "S2 KEDA red",
}
SCENARIO_LABELS = {
    "low": "Low",
    "high": "High",
    "ramp": "Ramp",
    "spike": "Spike",
}
COLORS = {
    "STATIC": "#334155",
    "CPU_HPA": "#2563EB",
    "QUEUE_KEDA": "#D97706",
}

KEY_METRICS = [
    "workerMinutes",
    "cpuRequestCoreMinutes",
    "averageWorkers",
    "maximumWorkers",
    "averageCapacityUtilizationPercent",
    "idleCapacityPercent",
    "jobsPerWorkerMinute",
    "averageProcessingMs",
    "averageQueueWaitMs",
    "averageTurnaroundMs",
    "p95TurnaroundMs",
    "averageThroughput",
    "scaleUpReactionMs",
    "scalingActions",
    "scalingOscillations",
    "failedJobs",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis-dir", default="analysis/final")
    parser.add_argument("--output-dir", default="analysis/final/thesis")
    return parser.parse_args()


REGULAR_FONT = "/System/Library/Fonts/Supplemental/Times New Roman.ttf"
BOLD_FONT = "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(BOLD_FONT if bold else REGULAR_FONT, size)


def text_center(draw: ImageDraw.ImageDraw, xy: tuple[float, float], value: str, text_font: ImageFont.FreeTypeFont, fill: str = "#111827") -> None:
    box = draw.textbbox((0, 0), value, font=text_font)
    draw.text((xy[0] - (box[2] - box[0]) / 2, xy[1] - (box[3] - box[1]) / 2), value, font=text_font, fill=fill)


def text_right(draw: ImageDraw.ImageDraw, xy: tuple[float, float], value: str, text_font: ImageFont.FreeTypeFont, fill: str = "#111827") -> None:
    box = draw.textbbox((0, 0), value, font=text_font)
    draw.text((xy[0] - (box[2] - box[0]), xy[1] - (box[3] - box[1]) / 2), value, font=text_font, fill=fill)


def rgb(hex_color: str) -> tuple[int, int, int]:
    value = hex_color.removeprefix("#")
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))


def decimal_comma(value: float, _position: int | None = None) -> str:
    if abs(value) >= 1000:
        text = f"{value:,.0f}"
    elif abs(value) >= 10:
        text = f"{value:.0f}"
    else:
        text = f"{value:.1f}"
    return text.replace(",", "X").replace(".", ",").replace("X", ".")


def validate(runs: pd.DataFrame, summary: pd.DataFrame, timeseries: pd.DataFrame) -> None:
    expected = pd.MultiIndex.from_product([SCENARIOS, POLICIES], names=["scenario", "deploymentPolicy"])
    counts = runs.groupby(["scenario", "deploymentPolicy"]).size().reindex(expected)
    if counts.isna().any() or not (counts == 5).all():
        raise ValueError(f"Očekuje se tačno pet ponavljanja po kombinaciji, dobijeno: {counts.to_dict()}")
    if int(runs["failedJobs"].sum()) != 0 or int(runs["incompleteJobs"].sum()) != 0:
        raise ValueError("Skup sadrži neuspješne ili nedovršene poslove.")
    if int(runs["submittedJobs"].sum()) != int(runs["completedJobs"].sum()):
        raise ValueError("Broj poslanih i završenih poslova nije jednak.")
    required_summary = set(KEY_METRICS) - {"scaleUpReactionMs"}
    present_summary = set(summary["metric"])
    if not required_summary.issubset(present_summary):
        raise ValueError(f"Nedostaju zbirne metrike: {sorted(required_summary - present_summary)}")
    required_ts = {"elapsedSeconds", "queueLength", "activeWorkers", "p95TurnaroundMs"}
    if not required_ts.issubset(timeseries.columns):
        raise ValueError(f"Nedostaju vremenske metrike: {sorted(required_ts - set(timeseries.columns))}")


def summary_value(summary: pd.DataFrame, scenario: str, policy: str, metric: str, column: str = "mean") -> float:
    row = summary[
        (summary["scenario"] == scenario)
        & (summary["deploymentPolicy"] == policy)
        & (summary["metric"] == metric)
    ]
    if len(row) != 1:
        raise ValueError(f"Nije pronađen jedinstven rezultat za {scenario}/{policy}/{metric}.")
    return float(row.iloc[0][column])


def build_tables(runs: pd.DataFrame, summary: pd.DataFrame, comparisons: pd.DataFrame, output_dir: Path) -> dict:
    selected = summary[summary["metric"].isin(KEY_METRICS)].copy()
    wide_mean = selected.pivot(index=["scenario", "deploymentPolicy"], columns="metric", values="mean")
    wide_sd = selected.pivot(index=["scenario", "deploymentPolicy"], columns="metric", values="sampleStdDev")
    order = pd.MultiIndex.from_product([SCENARIOS, POLICIES], names=["scenario", "deploymentPolicy"])
    wide_mean = wide_mean.reindex(order)
    wide_sd = wide_sd.reindex(order)
    wide_mean.columns = [f"{column}Mean" for column in wide_mean.columns]
    wide_sd.columns = [f"{column}SampleStdDev" for column in wide_sd.columns]
    final_table = pd.concat([wide_mean, wide_sd], axis=1).reset_index()
    final_table.to_csv(output_dir / "zbirni-rezultati.csv", index=False)

    relative = comparisons[comparisons["metric"].isin(KEY_METRICS)].copy()
    relative["scenario"] = pd.Categorical(relative["scenario"], SCENARIOS, ordered=True)
    relative["deploymentPolicy"] = pd.Categorical(relative["deploymentPolicy"], POLICIES, ordered=True)
    relative = relative.sort_values(["scenario", "deploymentPolicy", "metric"])
    relative.to_csv(output_dir / "promjene-u-odnosu-na-staticku.csv", index=False)

    facts = {
        "validRuns": int(len(runs)),
        "submittedJobs": int(runs["submittedJobs"].sum()),
        "completedJobs": int(runs["completedJobs"].sum()),
        "failedJobs": int(runs["failedJobs"].sum()),
        "incompleteJobs": int(runs["incompleteJobs"].sum()),
        "gitRevisions": sorted(runs["gitSha"].dropna().unique().tolist()),
        "cells": {},
    }
    for scenario in SCENARIOS:
        facts["cells"][scenario] = {}
        for policy in POLICIES:
            facts["cells"][scenario][policy] = {
                metric: {
                    statistic: summary_value(summary, scenario, policy, metric, statistic)
                    for statistic in ["mean", "median", "sampleStdDev", "p95", "minimum", "maximum"]
                    if not pd.isna(summary_value(summary, scenario, policy, metric, statistic))
                }
                for metric in KEY_METRICS
            }
    (output_dir / "kljucni-nalazi.json").write_text(json.dumps(facts, indent=2) + "\n", encoding="utf-8")
    return facts


def grouped_bar(
    summary: pd.DataFrame,
    metric: str,
    ylabel: str,
    title: str,
    output_path: Path,
    scale: float = 1.0,
    log_scale: bool = False,
) -> None:
    image = Image.new("RGB", (2200, 1100), "white")
    draw = ImageDraw.Draw(image)
    left, right, top, bottom = 230, 80, 150, 250
    plot_left, plot_right = left, image.width - right
    plot_top, plot_bottom = top, image.height - bottom
    plot_width, plot_height = plot_right - plot_left, plot_bottom - plot_top
    title_font, label_font, tick_font, value_font = font(38, True), font(29), font(25), font(21)
    text_center(draw, (image.width / 2, 55), title, title_font)

    all_means = {
        policy: np.array([summary_value(summary, scenario, policy, metric) / scale for scenario in SCENARIOS])
        for policy in POLICIES
    }
    all_sd = {
        policy: np.array([summary_value(summary, scenario, policy, metric, "sampleStdDev") / scale for scenario in SCENARIOS])
        for policy in POLICIES
    }
    if log_scale:
        y_min = 0.4
        y_max = max(float((all_means[policy] + all_sd[policy]).max()) for policy in POLICIES) * 1.25
        ticks = [value for value in [0.5, 1, 2, 5, 10, 20, 50] if y_min <= value <= y_max]

        def y_position(value: float) -> float:
            return plot_bottom - (np.log10(max(value, y_min)) - np.log10(y_min)) / (np.log10(y_max) - np.log10(y_min)) * plot_height
    else:
        y_min = 0.0
        y_max = max(float((all_means[policy] + all_sd[policy]).max()) for policy in POLICIES) * 1.18
        raw_step = y_max / 5
        magnitude = 10 ** np.floor(np.log10(raw_step))
        step = min([1, 2, 2.5, 5, 10], key=lambda candidate: abs(candidate * magnitude - raw_step)) * magnitude
        y_max = np.ceil(y_max / step) * step
        ticks = list(np.arange(0, y_max + step / 2, step))

        def y_position(value: float) -> float:
            return plot_bottom - value / y_max * plot_height

    for tick in ticks:
        y = y_position(tick)
        draw.line((plot_left, y, plot_right, y), fill="#CBD5E1", width=2)
        text_right(draw, (plot_left - 18, y), decimal_comma(tick), tick_font, "#334155")
    draw.line((plot_left, plot_top, plot_left, plot_bottom), fill="#64748B", width=2)
    draw.line((plot_left, plot_bottom, plot_right, plot_bottom), fill="#64748B", width=2)

    group_width = plot_width / len(SCENARIOS)
    offsets = [-0.25, 0, 0.25]
    bar_width = group_width * 0.19
    for scenario_index, scenario in enumerate(SCENARIOS):
        center = plot_left + group_width * (scenario_index + 0.5)
        for policy_index, policy in enumerate(POLICIES):
            mean = float(all_means[policy][scenario_index])
            deviation = float(all_sd[policy][scenario_index])
            x = center + offsets[policy_index] * group_width
            color = COLORS[policy]
            y = y_position(mean)
            y_low = y_position(max(y_min if log_scale else 0, mean - deviation))
            y_high = y_position(mean + deviation)
            if log_scale:
                draw.line((x, y_low, x, y_high), fill=color, width=5)
                draw.line((x - 11, y_low, x + 11, y_low), fill=color, width=4)
                draw.line((x - 11, y_high, x + 11, y_high), fill=color, width=4)
                draw.ellipse((x - 11, y - 11, x + 11, y + 11), fill=color, outline="white", width=2)
            else:
                draw.rectangle((x - bar_width / 2, y, x + bar_width / 2, plot_bottom), fill=color, outline="white", width=2)
                draw.line((x, y_low, x, y_high), fill="#111827", width=3)
                draw.line((x - 9, y_low, x + 9, y_low), fill="#111827", width=3)
                draw.line((x - 9, y_high, x + 9, y_high), fill="#111827", width=3)
            text_center(draw, (x, max(plot_top + 18, y_high - 28)), decimal_comma(mean), value_font, "#111827")
        text_center(draw, (center, plot_bottom + 42), SCENARIO_LABELS[scenario], label_font)

    ylabel_image = Image.new("RGBA", (900, 55), (255, 255, 255, 0))
    ylabel_draw = ImageDraw.Draw(ylabel_image)
    text_center(ylabel_draw, (450, 27), ylabel, label_font)
    ylabel_image = ylabel_image.rotate(90, expand=True)
    image.paste(ylabel_image, (18, int((image.height - ylabel_image.height) / 2)), ylabel_image)
    if log_scale:
        draw.text((plot_right - 250, plot_bottom - 38), "Logaritamska y-osa", font=font(21), fill="#475569")
    legend_y = image.height - 86
    legend_x = 410
    for policy in POLICIES:
        draw.rectangle((legend_x, legend_y - 12, legend_x + 34, legend_y + 12), fill=COLORS[policy])
        draw.text((legend_x + 48, legend_y - 18), POLICY_LABELS[policy], font=label_font, fill="#111827")
        legend_x += 520
    image.save(output_path, dpi=(300, 300))


def planned_rate(scenario: str, seconds: np.ndarray) -> np.ndarray:
    rates = np.zeros_like(seconds, dtype=float)
    if scenario == "low":
        rates[(seconds >= 0) & (seconds <= 300)] = 1
    elif scenario == "high":
        rates[(seconds >= 0) & (seconds <= 300)] = 6
    elif scenario == "ramp":
        rates[(seconds >= 0) & (seconds < 60)] = 1
        mask = (seconds >= 60) & (seconds < 240)
        rates[mask] = 1 + (seconds[mask] - 60) * 7 / 180
        mask = (seconds >= 240) & (seconds <= 300)
        rates[mask] = 8 - (seconds[mask] - 240) * 6 / 60
    elif scenario == "spike":
        rates[(seconds >= 0) & (seconds < 60)] = 1
        mask = (seconds >= 60) & (seconds < 75)
        rates[mask] = 1 + (seconds[mask] - 60) * 14 / 15
        rates[(seconds >= 75) & (seconds < 135)] = 15
        mask = (seconds >= 135) & (seconds < 150)
        rates[mask] = 15 - (seconds[mask] - 135) * 14 / 15
        rates[(seconds >= 150) & (seconds <= 210)] = 1
    return rates


def interpolate_runs(group: pd.DataFrame, metric: str, grid: np.ndarray) -> np.ndarray:
    interpolated = []
    for _run_id, run in group.groupby("runId"):
        run = run.sort_values("elapsedSeconds")
        x = run["elapsedSeconds"].to_numpy(dtype=float)
        y = run[metric].fillna(0).to_numpy(dtype=float)
        unique_x, indices = np.unique(x, return_index=True)
        values = np.interp(grid, unique_x, y[indices])
        values[(grid < unique_x.min()) | (grid > unique_x.max())] = np.nan
        interpolated.append(values)
    return np.vstack(interpolated)


def dynamics_figure(timeseries: pd.DataFrame, scenario: str, output_path: Path) -> None:
    subset = timeseries[timeseries["scenario"] == scenario].copy()
    maximum = int(np.ceil(subset["elapsedSeconds"].max() / 10) * 10)
    grid = np.arange(0, maximum + 0.01, 2.0)
    image = Image.new("RGB", (2200, 2100), "white")
    draw = ImageDraw.Draw(image)
    text_center(draw, (image.width / 2, 55), f"Dinamika sistema tokom profila {SCENARIO_LABELS[scenario]}", font(38, True))
    left, right, top, bottom, gap = 250, 85, 170, 170, 55
    panel_height = (image.height - top - bottom - 3 * gap) / 4
    plot_left, plot_right = left, image.width - right
    label_font, tick_font = font(27), font(23)
    panels = [
        (None, "Ulaz (poslova/s)", 1.0),
        ("queueLength", "Dužina reda", 1.0),
        ("activeWorkers", "Aktivni workeri", 1.0),
        ("p95TurnaroundMs", "P95 obrt (s)", 1000.0),
    ]
    for panel_index, (metric, label, divisor) in enumerate(panels):
        panel_top = top + panel_index * (panel_height + gap)
        panel_bottom = panel_top + panel_height
        series = {}
        if metric is None:
            series["INPUT"] = planned_rate(scenario, grid)
        else:
            for policy in POLICIES:
                values = interpolate_runs(subset[subset["deploymentPolicy"] == policy], metric, grid) / divisor
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", category=RuntimeWarning)
                    series[policy] = np.nanmedian(values, axis=0)
        finite_values = np.concatenate([values[np.isfinite(values)] for values in series.values()])
        y_max = max(1.0, float(finite_values.max()) * 1.12)
        if metric == "activeWorkers":
            y_max = 6.5
        ticks = np.linspace(0, y_max, 5)
        for tick in ticks:
            y = panel_bottom - tick / y_max * panel_height
            draw.line((plot_left, y, plot_right, y), fill="#D6DEE8", width=2)
            text_right(draw, (plot_left - 18, y), decimal_comma(tick), tick_font, "#334155")
        draw.line((plot_left, panel_top, plot_left, panel_bottom), fill="#64748B", width=2)
        draw.line((plot_left, panel_bottom, plot_right, panel_bottom), fill="#64748B", width=2)
        ylabel_image = Image.new("RGBA", (550, 55), (255, 255, 255, 0))
        ylabel_draw = ImageDraw.Draw(ylabel_image)
        text_center(ylabel_draw, (275, 27), label, label_font)
        ylabel_image = ylabel_image.rotate(90, expand=True)
        image.paste(ylabel_image, (30, int(panel_top + (panel_height - ylabel_image.height) / 2)), ylabel_image)

        for key, values in series.items():
            color = "#111827" if key == "INPUT" else COLORS[key]
            points = []
            for x_value, y_value in zip(grid, values):
                if np.isfinite(y_value):
                    x = plot_left + x_value / maximum * (plot_right - plot_left)
                    y = panel_bottom - y_value / y_max * panel_height
                    points.append((x, y))
                elif len(points) > 1:
                    draw.line(points, fill=color, width=4)
                    points = []
            if len(points) > 1:
                draw.line(points, fill=color, width=4)
        if panel_index == 3:
            for tick in np.linspace(0, maximum, 7):
                x = plot_left + tick / maximum * (plot_right - plot_left)
                text_center(draw, (x, panel_bottom + 38), decimal_comma(tick), tick_font)
    text_center(draw, (image.width / 2, image.height - 58), "Vrijeme od početka eksperimentalne sesije (s)", label_font)
    legend_x, legend_y = 390, 118
    for policy in POLICIES:
        draw.line((legend_x, legend_y, legend_x + 42, legend_y), fill=COLORS[policy], width=6)
        draw.text((legend_x + 54, legend_y - 18), POLICY_LABELS[policy], font=label_font, fill="#111827")
        legend_x += 520
    image.save(output_path, dpi=(300, 300))


def main() -> None:
    args = parse_args()
    analysis_dir = Path(args.analysis_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    runs = pd.read_csv(analysis_dir / "runs.csv")
    summary = pd.read_csv(analysis_dir / "summary.csv")
    comparisons = pd.read_csv(analysis_dir / "comparisons.csv")
    timeseries = pd.read_csv(analysis_dir / "timeseries.csv")
    validate(runs, summary, timeseries)
    facts = build_tables(runs, summary, comparisons, output_dir)
    grouped_bar(
        summary,
        "workerMinutes",
        "Aktivirani kapacitet (worker-minute)",
        "Aktivirani worker-kapacitet po profilu opterećenja",
        output_dir / "worker-minute-po-profilu.png",
    )
    grouped_bar(
        summary,
        "averageTurnaroundMs",
        "Prosječno vrijeme obrta (s)",
        "Prosječno vrijeme obrta po profilu opterećenja",
        output_dir / "vrijeme-obrta-po-profilu.png",
        scale=1000.0,
        log_scale=True,
    )
    dynamics_figure(timeseries, "high", output_dir / "dinamika-high.png")
    dynamics_figure(timeseries, "ramp", output_dir / "dinamika-ramp.png")
    dynamics_figure(timeseries, "spike", output_dir / "dinamika-spike.png")
    print(
        f"Generisano: {output_dir}\n"
        f"Validna izvođenja: {facts['validRuns']}; završeni poslovi: {facts['completedJobs']}; "
        f"greške: {facts['failedJobs']}"
    )


if __name__ == "__main__":
    main()
