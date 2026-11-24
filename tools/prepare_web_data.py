#!/usr/bin/env python3
"""Подготовить компактные данные для статического приложения.

Скрипт читает сохранённые результаты технической апробации ver1, проверяет
повторяемость расчёта и записывает ``web/data/data.json`` и ``web/data/data.js``.
Никакие исходные файлы не изменяются.

Пример запуска:

    python3 tools/prepare_web_data.py --source "../../НИР/vs code/ver1"
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from landscape_planning.gpkg import (  # noqa: E402
    polygons_area,
    read_first_geometry,
    simplify_polygons,
)
from landscape_planning.model import (  # noqa: E402
    COMBINED_MODES,
    LANDSCAPE_MODES,
    NORM_STATUSES,
    SCENARIO_DATA_STATUSES,
    classify_landscape,
    combine_mode,
    effective_norm_status,
    expected_scenario_status,
    normalize,
    weighted_index,
)

NORM_CODES = {name: index for index, name in enumerate(NORM_STATUSES)}
LANDSCAPE_CODES = {name: index for index, name in enumerate(LANDSCAPE_MODES)}
MODE_CODES = {name: index for index, name in enumerate(COMBINED_MODES)}
STATUS_CODES = {name: index for index, name in enumerate(SCENARIO_DATA_STATUSES)}
TOLERANCE = 1e-9


def load_config(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    if len(config.get("criteria", [])) != 4:
        raise ValueError("В конфигурации должно быть четыре критерия.")
    if len(config.get("scenarios", [])) != 4:
        raise ValueError("В конфигурации должно быть четыре сценария.")
    for scenario in config["scenarios"]:
        weights = [float(value) for value in scenario["weights"]]
        if len(weights) != 4:
            raise ValueError(f"Сценарий {scenario['key']}: нужно четыре веса.")
        # В демонстрационных весах НИР-2 сумма округлена до 0,999 или 1,001.
        # Пересчёт сохранённых результатов использует именно эти значения.
        if abs(sum(weights) - 1.0) > 0.01:
            raise ValueError(
                f"Сценарий {scenario['key']}: сумма весов {sum(weights)!r} "
                "отличается от 1 более чем на 0,01."
            )
    return config


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def parse_bool(value: str | bool | None) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "да"}


def optional_float(value: str | None) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if text == "" or text.lower() in {"nan", "none", "null"}:
        return None
    return float(text)


def round_or_none(value: float | None, digits: int) -> float | None:
    return None if value is None else round(float(value), digits)


def parse_zone_refs(value: str | None) -> list[dict[str, str]]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    refs: list[dict[str, str]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        zone_id = str(item.get("zone_id") or item.get("id") or "").strip()
        source = str(item.get("source") or "").strip()
        if not zone_id and not source:
            continue
        refs.append({"zone_id": zone_id, "source": source})
    return refs


def read_reports(source: Path, scenario: Mapping[str, Any]) -> dict[str, Any]:
    directory = source / "data" / "output" / str(scenario["source_dir"])
    reports: dict[str, Any] = {}
    for name in (
        "boundary_report.json",
        "grid_report.json",
        "landscape_report.json",
        "normative_report.json",
        "scenario_report.json",
    ):
        path = directory / name
        if not path.exists():
            raise FileNotFoundError(f"Не найден отчёт: {path}")
        reports[name.removesuffix(".json")] = json.loads(path.read_text(encoding="utf-8"))
    return reports


def load_scenario_tables(
    source: Path,
    config: Mapping[str, Any],
) -> tuple[dict[str, list[dict[str, str]]], dict[str, dict[str, Any]]]:
    tables: dict[str, list[dict[str, str]]] = {}
    reports: dict[str, dict[str, Any]] = {}
    for scenario in config["scenarios"]:
        key = str(scenario["key"])
        directory = source / "data" / "output" / str(scenario["source_dir"])
        csv_path = directory / "scenario_result.csv"
        if not csv_path.exists():
            raise FileNotFoundError(f"Не найден результат сценария: {csv_path}")
        rows = read_csv(csv_path)
        if len(rows) != 3468:
            raise ValueError(f"{key}: ожидалось 3468 ячеек, получено {len(rows)}.")
        tables[key] = rows
        reports[key] = read_reports(source, scenario)
    return tables, reports


def _raw_values(row: Mapping[str, str], criteria: Sequence[Mapping[str, Any]]) -> list[float | None]:
    return [optional_float(row.get(str(criterion["source_field"]))) for criterion in criteria]


def build_cells(
    config: Mapping[str, Any],
    tables: Mapping[str, list[dict[str, str]]],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, str]], dict[str, int]]:
    scenarios = list(config["scenarios"])
    criteria = list(config["criteria"])
    base_key = str(scenarios[0]["key"])
    base_rows = {row["cell_id"]: row for row in tables[base_key]}
    scenario_rows = {
        str(scenario["key"]): {
            row["cell_id"]: row for row in tables[str(scenario["key"])]
        }
        for scenario in scenarios
    }
    if len(base_rows) != len(tables[base_key]):
        raise ValueError("В базовом сценарии повторяются cell_id.")

    for scenario in scenarios:
        rows = tables[str(scenario["key"])]
        ids = {row["cell_id"] for row in rows}
        if ids != set(base_rows):
            missing = sorted(set(base_rows) - ids)[:5]
            extra = sorted(ids - set(base_rows))[:5]
            raise ValueError(
                f"Наборы ячеек не совпадают для {scenario['key']}: "
                f"missing={missing}, extra={extra}"
            )

    zone_sources: dict[str, dict[str, str]] = {}
    zone_usage: Counter[str] = Counter()
    cells: list[dict[str, Any]] = []

    for cell_id in sorted(
        base_rows,
        key=lambda value: (
            int(base_rows[value]["row_number"]),
            int(base_rows[value]["column_number"]),
        ),
    ):
        base = base_rows[cell_id]
        row_number = int(base["row_number"])
        column_number = int(base["column_number"])

        # Физические критерии не зависят от сценария. В сохранённых результатах
        # они заполнены только там, где ландшафтный этап был разрешён, поэтому
        # собираем их из всех сценариев. Это не подмена официального расчёта:
        # для каждого сценария ниже отдельно хранится, были ли у него свои
        # показатели и рассчитан ли официальный индекс.
        bank_raw: list[float | None] = [None, None, None, None]
        bank_valid: list[float | None] = [None, None]
        own_raw: dict[str, list[float | None]] = {}
        for scenario in scenarios:
            key = str(scenario["key"])
            row = scenario_rows[key].get(cell_id)
            if row is None:
                raise ValueError(f"{key}: нет строки для {cell_id}.")
            raw = _raw_values(row, criteria)
            own_raw[key] = raw
            for index, value in enumerate(raw):
                if value is None:
                    continue
                if bank_raw[index] is not None and abs(bank_raw[index] - value) > 1e-9:
                    raise ValueError(
                        f"{cell_id}: критерий {criteria[index]['key']} "
                        "различается между сценариями."
                    )
                bank_raw[index] = value
            for index, field in enumerate(
                ("slope_valid_share", "natural_cover_valid_share")
            ):
                value = optional_float(row.get(field))
                if value is None:
                    continue
                if bank_valid[index] is not None and abs(bank_valid[index] - value) > 1e-9:
                    raise ValueError(
                        f"{cell_id}: доля действительных данных {field} "
                        "различается между сценариями."
                    )
                bank_valid[index] = value

        bank_complete = all(value is not None for value in bank_raw)
        if bank_complete:
            bank_status = "complete"
        elif any(value is not None for value in bank_raw):
            bank_status = "partial"
        else:
            bank_status = "not_available"

        cell: dict[str, Any] = {
            "id": cell_id,
            "row": row_number,
            "column": column_number,
            "inside_share": float(base["inside_share"]),
            "is_boundary": parse_bool(base.get("is_boundary")),
            "raw": bank_raw,
            "valid": bank_valid,
            "landscape_status": bank_status,
            "scenarios": {},
        }

        for scenario in scenarios:
            key = str(scenario["key"])
            row = scenario_rows[key].get(cell_id)
            if row is None:
                raise ValueError(f"{key}: нет строки для {cell_id}.")
            raw = own_raw[key]
            has_all_own = all(value is not None for value in raw)
            shares = {
                "prohibited": optional_float(row.get("prohibited_share")) or 0.0,
                "conditional": optional_float(row.get("conditional_share")) or 0.0,
                "allowed": optional_float(row.get("allowed_share")) or 0.0,
                "unclassified": optional_float(row.get("unclassified_share")) or 0.0,
                "no_known_restrictions": optional_float(
                    row.get("no_known_restrictions_share")
                )
                or 0.0,
                "not_assessed": optional_float(row.get("not_assessed_share")) or 0.0,
            }
            norm_status = str(row.get("norm_status") or "")
            effective = effective_norm_status(
                norm_status,
                prohibited_share=shares["prohibited"],
                unclassified_share=shares["unclassified"],
                not_assessed_share=shares["not_assessed"],
            )
            expected = expected_scenario_status(
                norm_status,
                prohibited_share=shares["prohibited"],
                unclassified_share=shares["unclassified"],
                not_assessed_share=shares["not_assessed"],
                has_all_criteria=has_all_own,
            )
            saved_status = str(row.get("scenario_data_status") or "")
            if expected != saved_status:
                raise ValueError(
                    f"{key}/{cell_id}: ожидался статус {expected}, сохранён {saved_status}."
                )

            zones = parse_zone_refs(row.get("zone_refs"))
            zone_ids: list[str] = []
            for ref in zones:
                zone_id = ref["zone_id"] or ref["source"]
                if not zone_id:
                    continue
                if zone_id not in zone_ids:
                    zone_ids.append(zone_id)
                if zone_id not in zone_sources:
                    zone_sources[zone_id] = {
                        "id": ref["zone_id"],
                        "source": ref["source"],
                    }
                zone_usage[zone_id] += 1

            official_si = optional_float(row.get("sensitivity_index"))
            official_lm = str(row.get("landscape_mode") or "not_calculated")
            official_rm = str(row.get("recommended_mode") or "not_calculated")
            normalized = [
                optional_float(row.get("slope_normalized")),
                optional_float(row.get("hydro_normalized")),
                optional_float(row.get("natural_cover_normalized")),
                optional_float(row.get("development_normalized")),
            ]

            diagnostic_si: float | None = None
            diagnostic_lm: str | None = None
            if bank_complete:
                values = [float(value) for value in bank_raw if value is not None]
                recomputed_z, diagnostic_si = weighted_index(
                    values,
                    [float(value) for value in scenario["weights"]],
                    criteria,
                    development_direction=str(scenario["development_direction"]),
                )
                diagnostic_lm = classify_landscape(diagnostic_si)
                if saved_status == "calculated":
                    if official_si is None or abs(official_si - diagnostic_si) > 1e-9:
                        raise ValueError(
                            f"{key}/{cell_id}: сохранённый индекс не совпал с пересчётом."
                        )
                    if official_lm != diagnostic_lm:
                        raise ValueError(
                            f"{key}/{cell_id}: сохранённый класс не совпал с пересчётом."
                        )
                    for index, value in enumerate(recomputed_z):
                        if normalized[index] is None or abs(normalized[index] - value) > 1e-9:
                            raise ValueError(
                                f"{key}/{cell_id}: нормализованный критерий "
                                f"{index + 1} не совпал с пересчётом."
                            )
                    expected_rm = combine_mode(effective, diagnostic_lm)
                    if official_rm != expected_rm:
                        raise ValueError(
                            f"{key}/{cell_id}: рекомендуемый режим {official_rm} "
                            f"не совпал с пересчётом {expected_rm}."
                        )
            elif saved_status == "calculated":
                raise ValueError(
                    f"{key}/{cell_id}: официальный индекс есть, но физические "
                    "критерии не собраны."
                )

            cell["scenarios"][key] = {
                "norm": norm_status,
                "effective_norm": effective,
                "shares": shares,
                "zones": zone_ids,
                "si": official_si,
                "landscape": None if official_lm == "not_calculated" else official_lm,
                "recommended": official_rm,
                "status": saved_status,
                "own": has_all_own,
                "own_status": str(row.get("landscape_input_status") or ""),
                "diagnostic_si": diagnostic_si,
                "diagnostic_landscape": diagnostic_lm,
                "normalized": normalized if saved_status == "calculated" else None,
            }
        cells.append(cell)

    return cells, zone_sources, dict(zone_usage)


def compute_stats(
    cells: Sequence[Mapping[str, Any]],
    scenario_key: str,
) -> dict[str, Any]:
    records = [cell["scenarios"][scenario_key] for cell in cells]
    status_counts = Counter(record["status"] for record in records)
    dominant_counts = Counter(record["norm"] for record in records)
    effective_counts = Counter(record["effective_norm"] for record in records)
    recommended_counts = Counter(record["recommended"] for record in records)
    landscape_counts = Counter(
        record["landscape"] for record in records if record["landscape"]
    )
    return {
        "total": len(records),
        "calculated": status_counts.get("calculated", 0),
        "excluded": status_counts.get("normatively_prohibited", 0),
        "review": status_counts.get("normative_review_required", 0),
        "missing": status_counts.get("landscape_data_missing", 0)
        + status_counts.get("normative_data_missing", 0),
        "insufficient": status_counts.get("normative_review_required", 0)
        + status_counts.get("landscape_data_missing", 0)
        + status_counts.get("normative_data_missing", 0),
        "status_counts": dict(sorted(status_counts.items())),
        "dominant_norm_counts": dict(sorted(dominant_counts.items())),
        "effective_norm_counts": dict(sorted(effective_counts.items())),
        "recommended_counts": dict(sorted(recommended_counts.items())),
        "landscape_counts": dict(sorted(landscape_counts.items())),
    }


def _flag_names(record: Mapping[str, Any]) -> list[str]:
    flags: list[str] = []
    if record["effective_norm"] == "prohibited":
        flags.append("R3")
    if record["effective_norm"] == "unclassified":
        flags.append("R2")
    if record["effective_norm"] == "not_assessed":
        flags.append("NO_NORM")
    if record["effective_norm"] == "conditional":
        flags.append("COND")
    if record["status"] != "calculated":
        flags.append("NOT_CALCULATED")
    return flags


def _candidate(
    cell: Mapping[str, Any],
    scenario_key: str,
    *,
    use_official: bool,
) -> dict[str, Any] | None:
    record = cell["scenarios"][scenario_key]
    if use_official and record["si"] is not None:
        si = float(record["si"])
        landscape = record["landscape"]
        source = "official"
    elif record["diagnostic_si"] is not None:
        si = float(record["diagnostic_si"])
        landscape = record["diagnostic_landscape"]
        source = "diagnostic"
    else:
        return None
    return {
        "cell_id": cell["id"],
        "row": cell["row"],
        "column": cell["column"],
        "si": round(si, 6),
        "landscape": landscape,
        "recommended": record["recommended"],
        "norm": record["norm"],
        "effective_norm": record["effective_norm"],
        "flags": _flag_names(record),
        "inside_share": round(float(cell["inside_share"]), 6),
        "boundary": bool(cell["is_boundary"]),
        "source": source,
    }


def _rank(candidates: Iterable[dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    ordered = sorted(
        candidates,
        key=lambda item: (
            item["si"],
            -item["inside_share"],
            item["row"],
            item["column"],
        ),
    )
    return ordered[:limit]


def _rank_stats(candidates: Sequence[dict[str, Any]], top: Sequence[dict[str, Any]]) -> dict[str, Any]:
    top_flags = Counter(flag for item in top for flag in item["flags"])
    return {
        "candidate_count": len(candidates),
        "top": list(top),
        "top_flag_counts": dict(sorted(top_flags.items())),
    }


def compute_experiment(
    cells: Sequence[Mapping[str, Any]],
    config: Mapping[str, Any],
) -> dict[str, Any]:
    scenarios = list(config["scenarios"])
    scenario_keys = [str(scenario["key"]) for scenario in scenarios]
    definitions = {
        "A": "Наивный рейтинг без нормативного фильтра: все ячейки с полным набором физических критериев, включая запрещённые. R2 и ячейки без нормативной оценки попадают в набор только при наличии диагностического индекса. Для исключённых ячеек индекс диагностический, вне метода.",
        "B": "Рейтинг с исключением R3: запрещённые ячейки убраны. R2 и ячейки без нормативной оценки сохраняются в данных с флагами, но не ранжируются, если диагностический индекс недоступен.",
        "C": "Рабочий рейтинг: исключены R3, R2 и ячейки без нормативной оценки; учитываются только ячейки с рассчитанным официальным индексом.",
        "D": "Сравнение сценариев: топ-10 по правилу C, пересечения, уникальные ячейки и конфликты режимов.",
    }

    result: dict[str, Any] = {
        "definitions": definitions,
        "scenarios": {},
        "cross_scenario": {},
    }

    for scenario in scenarios:
        key = str(scenario["key"])
        records = [cell["scenarios"][key] for cell in cells]
        complete = [
            cell
            for cell in cells
            if cell["scenarios"][key]["diagnostic_si"] is not None
        ]
        counts = {
            "total": len(cells),
            "complete_criteria": len(complete),
            "missing_criteria": len(cells) - len(complete),
            "calculated": sum(1 for record in records if record["status"] == "calculated"),
            "prohibited": sum(
                1 for record in records if record["effective_norm"] == "prohibited"
            ),
            "review": sum(
                1 for record in records if record["effective_norm"] == "unclassified"
            ),
            "not_assessed": sum(
                1 for record in records if record["effective_norm"] == "not_assessed"
            ),
            "conditional": sum(
                1 for record in records if record["effective_norm"] == "conditional"
            ),
            "no_known": sum(
                1
                for record in records
                if record["effective_norm"] == "no_known_restrictions"
            ),
            "allowed": sum(1 for record in records if record["effective_norm"] == "allowed"),
        }

        # A: все полные ячейки, диагностический индекс.
        candidates_a = [
            item
            for cell in complete
            if (item := _candidate(cell, key, use_official=False)) is not None
        ]
        top_a = _rank(candidates_a)
        experiment_a = _rank_stats(candidates_a, top_a)
        experiment_a["prohibited_in_top"] = sum(
            1 for item in top_a if "R3" in item["flags"]
        )
        experiment_a["review_in_top"] = sum(
            1 for item in top_a if "R2" in item["flags"]
        )

        # B: исключаем только запрет.
        candidates_b = [
            item
            for cell in complete
            if cell["scenarios"][key]["effective_norm"] != "prohibited"
            and (item := _candidate(cell, key, use_official=True)) is not None
        ]
        top_b = _rank(candidates_b)
        experiment_b = _rank_stats(candidates_b, top_b)
        experiment_b["excluded_prohibited"] = counts["prohibited"]
        experiment_b["review_in_top"] = sum(
            1 for item in top_b if "R2" in item["flags"]
        )
        experiment_b["not_assessed_in_top"] = sum(
            1 for item in top_b if "NO_NORM" in item["flags"]
        )

        # C: рабочий рейтинг только по допустимым и условным ячейкам.
        allowed_norms = {"allowed", "conditional", "no_known_restrictions"}
        candidates_c = [
            item
            for cell in complete
            if cell["scenarios"][key]["status"] == "calculated"
            and cell["scenarios"][key]["effective_norm"] in allowed_norms
            and (item := _candidate(cell, key, use_official=True)) is not None
        ]
        top_c = _rank(candidates_c)
        experiment_c = _rank_stats(candidates_c, top_c)
        experiment_c["excluded_prohibited"] = counts["prohibited"]
        experiment_c["excluded_review"] = counts["review"]
        experiment_c["excluded_not_assessed"] = counts["not_assessed"]
        experiment_c["excluded_missing_criteria"] = counts["missing_criteria"]
        flagged_review: list[dict[str, Any]] = []
        for cell in cells:
            record = cell["scenarios"][key]
            if record["effective_norm"] != "unclassified":
                continue
            candidate = _candidate(cell, key, use_official=False)
            if candidate is None:
                candidate = {
                    "cell_id": cell["id"],
                    "row": cell["row"],
                    "column": cell["column"],
                    "si": None,
                    "landscape": None,
                    "recommended": record["recommended"],
                    "norm": record["norm"],
                    "effective_norm": record["effective_norm"],
                    "flags": ["R2"],
                    "inside_share": round(float(cell["inside_share"]), 6),
                    "boundary": bool(cell["is_boundary"]),
                    "source": "not_available",
                }
            flagged_review.append(candidate)
        experiment_c["flagged_review"] = flagged_review[:10]
        experiment_c["flagged_review_total"] = len(flagged_review)
        experiment_c["flagged_review_with_diagnostics"] = sum(
            1 for item in flagged_review if item["si"] is not None
        )

        result["scenarios"][key] = {
            "label": scenario["label"],
            "counts": counts,
            "A": experiment_a,
            "B": experiment_b,
            "C": experiment_c,
        }

    # D: сравнение топ-10 и режимов.
    top_sets = {
        key: {item["cell_id"] for item in result["scenarios"][key]["C"]["top"]}
        for key in scenario_keys
    }
    pairwise: dict[str, dict[str, int]] = {}
    for left in scenario_keys:
        pairwise[left] = {}
        for right in scenario_keys:
            intersection = len(top_sets[left] & top_sets[right])
            union = len(top_sets[left] | top_sets[right])
            pairwise[left][right] = round(intersection / union, 6) if union else 0.0
    all_top = set.intersection(*(top_sets[key] for key in scenario_keys)) if scenario_keys else set()
    unique_top = sum(
        1 for cell_id in set().union(*top_sets.values()) if sum(cell_id in top_sets[key] for key in scenario_keys) == 1
    )

    conflict_examples: list[dict[str, Any]] = []
    conflict_count = 0
    development_conflict_count = 0
    preservation_vs_development_count = 0
    for cell in cells:
        modes: dict[str, str] = {}
        for key in scenario_keys:
            record = cell["scenarios"][key]
            if record["status"] == "calculated":
                modes[key] = record["recommended"]
            elif record["status"] == "normatively_prohibited":
                modes[key] = "scenario_excluded"
            elif record["status"] == "normative_review_required":
                modes[key] = "normative_review_required"
            elif record["status"] == "landscape_data_missing":
                modes[key] = "landscape_data_missing"
            elif record["status"] == "normative_data_missing":
                modes[key] = "normative_data_missing"
        distinct = set(modes.values())
        if len(distinct) >= 2:
            conflict_count += 1
            development = {"intensive_development", "extensive_development", "limited_development"}
            blockers = {
                "scenario_excluded",
                "normative_review_required",
                "normative_data_missing",
            }
            if distinct & development and distinct & blockers:
                development_conflict_count += 1
            if "preservation" in distinct and distinct & development:
                preservation_vs_development_count += 1
            conflict_examples.append(
                {
                    "cell_id": cell["id"],
                    "row": cell["row"],
                    "column": cell["column"],
                    "modes": modes,
                    "distinct_count": len(distinct),
                }
            )

    conflict_examples.sort(
        key=lambda item: (-item["distinct_count"], item["cell_id"])
    )
    result["cross_scenario"] = {
        "top10_overlap_jaccard": pairwise,
        "top10_all": sorted(all_top),
        "top10_all_count": len(all_top),
        "top10_unique_count": unique_top,
        "conflict_count": conflict_count,
        "development_conflict_count": development_conflict_count,
        "preservation_vs_development_count": preservation_vs_development_count,
        "conflict_examples": conflict_examples[:12],
        "conflict_examples_total": len(conflict_examples),
    }
    return result


def read_boundary(
    source: Path,
    scenario: Mapping[str, Any],
    grid_report: Mapping[str, Any],
) -> tuple[list[list[list[list[float]]]], dict[str, Any]]:
    directory = source / "data" / "output" / str(scenario["source_dir"])
    path = directory / "working_boundary.gpkg"
    if not path.exists():
        raise FileNotFoundError(f"Не найдена рабочая граница: {path}")
    polygons = read_first_geometry(path, "working_boundary")
    area_m2 = polygons_area(polygons)
    area_km2 = area_m2 / 1_000_000.0
    expected_area = float(grid_report["territory_area_sq_km"])
    if abs(area_km2 - expected_area) > 1e-6:
        raise ValueError(
            f"Площадь границы {area_km2:.9f} км² не совпала с отчётом {expected_area:.9f}."
        )

    origin_x = float(grid_report["origin_x_m"])
    origin_y = float(grid_report["origin_y_m"])
    rows = int(grid_report["extent_row_count"])
    columns = int(grid_report["extent_column_count"])
    cell_size = float(grid_report["used_cell_size_m"])
    max_y = origin_y + rows * cell_size

    selected = polygons
    selected_tolerance = 0.0
    for tolerance in (10.0, 20.0, 30.0, 50.0, 75.0, 100.0):
        simplified = simplify_polygons(polygons, tolerance)
        simplified_area = polygons_area(simplified)
        relative_error = abs(simplified_area - area_m2) / area_m2 if area_m2 else 1.0
        point_count = sum(len(ring) for polygon in simplified for ring in polygon)
        if relative_error <= 0.001 and point_count <= 500:
            selected = simplified
            selected_tolerance = tolerance
            break

    boundary: list[list[list[list[float]]]] = []
    for polygon in selected:
        boundary_polygon: list[list[list[float]]] = []
        for ring in polygon:
            boundary_polygon.append(
                [
                    [
                        round(x - origin_x, 2),
                        round(max_y - y, 2),
                    ]
                    for x, y in ring
                ]
            )
        boundary.append(boundary_polygon)

    all_points = [
        point
        for polygon in boundary
        for ring in polygon
        for point in ring
    ]
    bbox = [
        min(point[0] for point in all_points),
        min(point[1] for point in all_points),
        max(point[0] for point in all_points),
        max(point[1] for point in all_points),
    ]
    metadata = {
        "area_km2": round(area_km2, 6),
        "simplification_tolerance_m": selected_tolerance,
        "source_point_count": sum(len(ring) for polygon in polygons for ring in polygon),
        "display_point_count": sum(len(ring) for polygon in selected for ring in polygon),
        "bbox": [round(value, 2) for value in bbox],
    }
    return boundary, metadata


def build_meta(
    config: Mapping[str, Any],
    cells: Sequence[Mapping[str, Any]],
    tables: Mapping[str, list[dict[str, str]]],
    reports: Mapping[str, Mapping[str, Any]],
    boundary: list[list[list[list[float]]]],
    boundary_meta: Mapping[str, Any],
    zone_sources: Mapping[str, Mapping[str, str]],
    zone_usage: Mapping[str, int],
) -> dict[str, Any]:
    base_key = str(config["scenarios"][0]["key"])
    base_report = reports[base_key]
    grid_report = base_report["grid_report"]
    boundary_report = base_report["boundary_report"]
    landscape_report = base_report["landscape_report"]
    normative_report = base_report["normative_report"]

    scenario_meta = []
    for scenario in config["scenarios"]:
        key = str(scenario["key"])
        stats = compute_stats(cells, key)
        report = reports[key]["scenario_report"]
        report_counts = report.get("recommended_mode_counts", {})
        for mode, count in report_counts.items():
            if stats["recommended_counts"].get(mode, 0) != int(count):
                raise ValueError(
                    f"{key}: счётчик режима {mode} не совпал с отчётом "
                    f"({stats['recommended_counts'].get(mode, 0)} != {count})."
                )
        if stats["calculated"] != int(report["calculated_cell_count"]):
            raise ValueError(f"{key}: число рассчитанных ячеек не совпало с отчётом.")
        if stats["excluded"] != int(report["excluded_cell_count"]):
            raise ValueError(f"{key}: число исключённых ячеек не совпало с отчётом.")
        scenario_meta.append(
            {
                "key": key,
                "label": scenario["label"],
                "short_label": scenario["short_label"],
                "source_dir": scenario["source_dir"],
                "report_code": scenario["report_code"],
                "weights": [round(float(value), 6) for value in scenario["weights"]],
                "weight_sum": round(sum(float(value) for value in scenario["weights"]), 6),
                "development_direction": scenario["development_direction"],
                "color": scenario["color"],
                "description": scenario["description"],
                "stats": stats,
                "report_warnings": report.get("warnings", []),
                "parameter_status": report.get("parameter_status"),
            }
        )

    criteria_meta = []
    for criterion in config["criteria"]:
        criteria_meta.append(
            {
                "key": criterion["key"],
                "label": criterion["label"],
                "short_label": criterion["short_label"],
                "unit": criterion["unit"],
                "source_field": criterion["source_field"],
                "normalized_field": criterion["normalized_field"],
                "lower": float(criterion["lower"]),
                "upper": float(criterion["upper"]),
                "direction": criterion["direction"],
                "direction_label": criterion["direction_label"],
                "description": criterion["description"],
            }
        )

    data_sources = [
        {
            "name": "Граница территории",
            "source": "OpenStreetMap",
            "date": "2026-11-10",
            "license": "© OpenStreetMap contributors, ODbL 1.0",
            "details": (
                f"Рабочая граница EPSG:32648, площадь "
                f"{float(boundary_report['area_sq_km']):.6f} км². "
                "Граница OSM может не совпадать с официальной."
            ),
        },
        {
            "name": "DEM",
            "source": "Файл dem.tif из технической апробации",
            "date": "не указана",
            "license": "не указана в отчёте",
            "details": "Крутизна рассчитана по DEM; источник и параметры требуют сверки.",
        },
        {
            "name": "Гидрография",
            "source": "OpenStreetMap / Overpass API",
            "date": "2026-11-10",
            "license": "© OpenStreetMap contributors, ODbL 1.0",
            "details": "1259 объектов в буфере 1000 м; полнота зависит от OSM.",
        },
        {
            "name": "Здания",
            "source": "OpenStreetMap APIs",
            "date": "2026-11-10",
            "license": "© OpenStreetMap contributors, ODbL 1.0",
            "details": "1081 контур; мультиполигональные relations не включены.",
        },
        {
            "name": "Природный покров",
            "source": "ESA WorldCover 2021 v200",
            "date": "2021",
            "license": "CC-BY-4.0",
            "details": "Классы 10, 20, 30, 90, 100; перечень природных классов требует утверждения.",
        },
        {
            "name": "Нормативные зоны",
            "source": "НСПД: ЗОУИТ",
            "date": "не указана",
            "license": "требует проверки по источнику",
            "details": "78 зон, режим restrictions_only; первичный скрининг, не юридическое заключение.",
        },
    ]

    contradictions = [
        {
            "title": "Синтетическая демонстрация и техническая апробация",
            "text": "В согласованном тексте НИР-2 описана синтетическая демонстрация и планируемая апробация Байкальска. В ver1 уже есть технический триал Байкальска с демонстрационными параметрами. Приложение использует именно триал и явно маркирует его статус.",
        },
        {
            "title": "Параметры не утверждены",
            "text": "SCENARIO_SPEC фиксирует, что веса, границы и пороги для апробации не утверждены. Код ver1 всё равно применяет демонстрационные параметры НИР-2 с предупреждением. Приложение не выдаёт их за утверждённый метод.",
        },
        {
            "title": "Запрет и доля запрета",
            "text": "Задание говорит об исключении ячеек с полным запретом. В ver1 ячейка исключается при любой положительной доле запрета. Из 12 исключённых ячеек жилищного сценария только одна имеет долю запрета 1,0; остальные — частичный запрет. Это консервативное правило требует методического уточнения.",
        },
        {
            "title": "Индекс для R3 в синтетическом CSV",
            "text": "В synthetic_demo_results.csv для ячейки D (R3) индекс LS рассчитан, хотя итог — «Сценарий исключён». В приложении для R3 индекс и рекомендация не показываются; расхождение сохранено в описании проверки.",
        },
        {
            "title": "no_known_restrictions ≠ allowed",
            "text": "Для слоя ЗОУИТ площадь вне найденных зон получает no_known_restrictions. Это не юридическое разрешение. Приложение показывает это отдельной подписью.",
        },
        {
            "title": "Сумма демонстрационных весов",
            "text": "В НИР-2 сумма весов должна быть равна 1. У сохранённых демонстрационных наборов она составляет 0,999 (промышленный) и 1,001 (рекреационный) из-за округления. Пересчёт использует сохранённые значения без перенормировки, чтобы совпадать с результатами триала.",
        },
        {
            "title": "Версии жилищного сценария",
            "text": "Используется housing_trial_v2, на которую ссылается scenario_comparison.csv. Версия v1 имеет другую трактовку покрытия и не используется.",
        },
        {
            "title": "Граница OSM",
            "text": "Граница территории взята из OpenStreetMap и может не совпадать с официальной административной границей.",
        },
    ]

    meta = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "project_title": config["project_title"],
        "territory": config["territory"],
        "dataset_note": config["dataset_note"],
        "parameter_status": config["parameter_status"],
        "parameter_status_label": config["parameter_status_label"],
        "parameter_status_warning": config["parameter_status_warning"],
        "crs": "EPSG:32648",
        "crs_name": "WGS 84 / UTM zone 48N",
        "grid": {
            "origin_x": float(grid_report["origin_x_m"]),
            "origin_y": float(grid_report["origin_y_m"]),
            "rows": int(grid_report["extent_row_count"]),
            "columns": int(grid_report["extent_column_count"]),
            "cell_size_m": float(grid_report["used_cell_size_m"]),
            "cell_count": int(grid_report["saved_cell_count"]),
            "boundary_cell_count": int(grid_report["boundary_cell_count"]),
            "width_m": float(grid_report["extent_column_count"]) * float(grid_report["used_cell_size_m"]),
            "height_m": float(grid_report["extent_row_count"]) * float(grid_report["used_cell_size_m"]),
            "territory_area_km2": float(grid_report["territory_area_sq_km"]),
            "rounding_applied": bool(grid_report["rounding_applied"]),
        },
        "boundary": boundary,
        "boundary_meta": dict(boundary_meta),
        "criteria": criteria_meta,
        "scenarios": scenario_meta,
        "norm_statuses": config["norm_statuses"],
        "effective_norm_rule": config["effective_norm_rule"],
        "modes": config["modes"],
        "thresholds": [float(value) for value in config["thresholds"]],
        "threshold_rule": config["threshold_rule"],
        "sources": config["sources"],
        "data_sources": data_sources,
        "limitations": config["limitations"],
        "contradictions": contradictions,
        "zone_sources": dict(sorted(zone_sources.items())),
        "zone_usage": dict(sorted(zone_usage.items())),
        "data_quality": {
            "boundary_report": boundary_report,
            "grid_report": grid_report,
            "landscape_report": landscape_report,
            "normative_report": normative_report,
        },
        "codes": {
            "norm": NORM_CODES,
            "landscape": LANDSCAPE_CODES,
            "mode": MODE_CODES,
            "status": STATUS_CODES,
        },
    }
    return meta


def encode_cells(
    cells: Sequence[Mapping[str, Any]],
    config: Mapping[str, Any],
    zone_sources: Mapping[str, Mapping[str, str]],
) -> list[dict[str, Any]]:
    scenario_keys = [str(scenario["key"]) for scenario in config["scenarios"]]
    encoded: list[dict[str, Any]] = []
    for cell in cells:
        records = []
        for key in scenario_keys:
            record = cell["scenarios"][key]
            shares = record["shares"]
            normalized = record["normalized"]
            records.append(
                [
                    NORM_CODES[record["effective_norm"]],
                    NORM_CODES[record["norm"]],
                    round(shares["prohibited"], 6),
                    round(shares["conditional"], 6),
                    round(shares["allowed"], 6),
                    round(shares["unclassified"], 6),
                    round(shares["no_known_restrictions"], 6),
                    round(shares["not_assessed"], 6),
                    round(float(record["si"]), 6) if record["si"] is not None else None,
                    LANDSCAPE_CODES[record["landscape"]]
                    if record["landscape"] is not None
                    else None,
                    MODE_CODES[record["recommended"]],
                    STATUS_CODES[record["status"]],
                    [round(float(value), 6) for value in normalized]
                    if normalized is not None
                    else None,
                    record["zones"],
                    1 if record["own"] else 0,
                    record["own_status"],
                ]
            )
        encoded.append(
            {
                "id": cell["id"],
                "r": cell["row"],
                "c": cell["column"],
                "b": 1 if cell["is_boundary"] else 0,
                "in": round(float(cell["inside_share"]), 6),
                "k": [
                    round_or_none(cell["raw"][0], 4),
                    round_or_none(cell["raw"][1], 2),
                    round_or_none(cell["raw"][2], 6),
                    round_or_none(cell["raw"][3], 2),
                ],
                "v": [
                    round_or_none(cell["valid"][0], 6),
                    round_or_none(cell["valid"][1], 6),
                ],
                "ls": cell["landscape_status"],
                "s": records,
            }
        )
    return encoded


def synthetic_check(source_root: Path, config: Mapping[str, Any]) -> dict[str, Any] | None:
    path = (
        source_root.parents[1]
        / "chat"
        / "synthetic_demo_output"
        / "synthetic_demo_results.csv"
    )
    if not path.exists():
        return None
    rows = read_csv(path)
    scenario_columns = {
        "housing": ("LS_Жилищный", "Режим_Жилищный", "Итог_Жилищный"),
        "industrial": (
            "LS_Производственный",
            "Режим_Производственный",
            "Итог_Производственный",
        ),
        "recreation_tourism": (
            "LS_Рекреационно-туристический",
            "Режим_Рекреационно-туристический",
            "Итог_Рекреационно-туристический",
        ),
        "transport_infrastructure": (
            "LS_Транспортно-инфраструктурный",
            "Режим_Транспортно-инфраструктурный",
            "Итог_Транспортно-инфраструктурный",
        ),
    }
    result_rows = []
    for row in rows:
        item: dict[str, Any] = {
            "cell": row["Ячейка"],
            "x": int(row["X"]),
            "y": int(row["Y"]),
            "k": [
                float(row["K1_уклон"]),
                float(row["K2_до_гидрографии"]),
                float(row["K3_природный_покров"]),
                float(row["K4_до_застройки"]),
            ],
            "norm": int(row["R"]),
            "norm_reason": row.get("Основание_R", ""),
            "scenarios": {},
        }
        for key, (ls_column, mode_column, final_column) in scenario_columns.items():
            item["scenarios"][key] = {
                "si": float(row[ls_column]),
                "landscape": row[mode_column],
                "final": row[final_column],
            }
        result_rows.append(item)
    return {
        "source": str(path),
        "note": "Проверка воспроизводит сохранённые значения; для R3 индекс показан как диагностический и в интерфейсе скрывается.",
        "rows": result_rows,
    }


def write_outputs(
    out_dir: Path,
    meta: Mapping[str, Any],
    cells: Sequence[Mapping[str, Any]],
    experiment: Mapping[str, Any],
    synthetic: Mapping[str, Any] | None,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": meta,
        "cells": cells,
        "experiment": experiment,
        "synthetic_check": synthetic,
    }
    json_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    (out_dir / "data.json").write_text(json_text + "\n", encoding="utf-8")
    (out_dir / "data.js").write_text(
        "window.LANDSCAPE_DATA=" + json_text + ";\n",
        encoding="utf-8",
    )

    csv_path = out_dir / "experiment.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "scenario",
                "experiment",
                "rank",
                "cell_id",
                "row",
                "column",
                "sensitivity_index",
                "landscape_mode",
                "recommended_mode",
                "norm_status",
                "effective_norm_status",
                "flags",
                "inside_share",
                "boundary",
                "index_source",
            ]
        )
        for key, scenario in experiment["scenarios"].items():
            for experiment_key in ("A", "B", "C"):
                for rank, item in enumerate(scenario[experiment_key]["top"], start=1):
                    writer.writerow(
                        [
                            key,
                            experiment_key,
                            rank,
                            item["cell_id"],
                            item["row"],
                            item["column"],
                            item["si"],
                            item["landscape"],
                            item["recommended"],
                            item["norm"],
                            item["effective_norm"],
                            "|".join(item["flags"]),
                            item["inside_share"],
                            int(item["boundary"]),
                            item["source"],
                        ]
                    )


def validate_payload(payload: Mapping[str, Any]) -> None:
    meta = payload["meta"]
    cells = payload["cells"]
    if len(cells) != meta["grid"]["cell_count"]:
        raise ValueError("Число ячеек в данных не совпало с сеткой.")
    if len(cells) != 3468:
        raise ValueError("Ожидалось 3468 ячеек Байкальского триала.")
    scenario_keys = [scenario["key"] for scenario in meta["scenarios"]]
    if len(scenario_keys) != 4:
        raise ValueError("Ожидались четыре сценария.")
    for cell in cells:
        if len(cell["s"]) != 4:
            raise ValueError(f"Ячейка {cell['id']}: не четыре сценарных записи.")
        for record in cell["s"]:
            if len(record) != 16:
                raise ValueError(f"Ячейка {cell['id']}: неверная длина записи.")
    for key in scenario_keys:
        stats = next(
            scenario["stats"] for scenario in meta["scenarios"] if scenario["key"] == key
        )
        if stats["total"] != 3468:
            raise ValueError(f"{key}: неверное общее число ячеек.")
        if stats["calculated"] + stats["excluded"] + stats["review"] + stats["missing"] != 3468:
            raise ValueError(f"{key}: суммы статусов не сходятся.")
    if not payload["experiment"]["scenarios"]:
        raise ValueError("Эксперимент не рассчитан.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Папка ver1 с data/input и data/output.",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=PROJECT_ROOT / "config" / "scenarios.json",
        help="Файл конфигурации сценариев.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=PROJECT_ROOT / "web" / "data",
        help="Папка для data.json и data.js.",
    )
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    if not (source / "data" / "output").is_dir():
        raise SystemExit(f"Не найдена папка результатов: {source / 'data' / 'output'}")
    config = load_config(args.config)
    tables, reports = load_scenario_tables(source, config)
    cells, zone_sources, zone_usage = build_cells(config, tables)
    boundary, boundary_meta = read_boundary(
        source,
        config["scenarios"][0],
        reports[str(config["scenarios"][0]["key"])]["grid_report"],
    )
    meta = build_meta(
        config,
        cells,
        tables,
        reports,
        boundary,
        boundary_meta,
        zone_sources,
        zone_usage,
    )
    experiment = compute_experiment(cells, config)
    synthetic = synthetic_check(source, config)
    encoded = encode_cells(cells, config, zone_sources)
    payload = {
        "meta": meta,
        "cells": encoded,
        "experiment": experiment,
        "synthetic_check": synthetic,
    }
    validate_payload(payload)
    write_outputs(args.out, meta, encoded, experiment, synthetic)

    size_mb = (args.out / "data.json").stat().st_size / (1024 * 1024)
    print(f"Записано: {args.out / 'data.json'} ({size_mb:.2f} МБ)")
    print(f"Записано: {args.out / 'data.js'}")
    print(f"Ячеек: {len(encoded)}; сценариев: {len(meta['scenarios'])}")
    print(f"Граница: {boundary_meta['display_point_count']} точек после упрощения")
    for scenario in meta["scenarios"]:
        stats = scenario["stats"]
        print(
            f"  {scenario['key']}: рассчитано {stats['calculated']}, "
            f"исключено {stats['excluded']}, проверка {stats['review']}, "
            f"нет данных {stats['missing']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
