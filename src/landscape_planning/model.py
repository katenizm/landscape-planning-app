"""Чистые функции демонстрационной сценарной модели.

Правила повторяют сохранённые результаты ver1: нормализация с ограничением
крайних значений, взвешенная сумма, классы по порогам 0,25 / 0,50 / 0,75 и
совмещение с нормативным статусом. Нормативная проверка выполняется до
ландшафтного расчёта.
"""

from __future__ import annotations

from typing import Iterable, Mapping, Sequence

TOLERANCE = 1e-9

NORM_STATUSES = (
    "no_known_restrictions",
    "conditional",
    "unclassified",
    "prohibited",
    "not_assessed",
    "allowed",
)

LANDSCAPE_MODES = (
    "intensive_development",
    "extensive_development",
    "limited_development",
    "preservation",
)

COMBINED_MODES = LANDSCAPE_MODES + (
    "normative_review_required",
    "scenario_excluded",
    "landscape_data_missing",
    "normative_data_missing",
    "not_calculated",
)

SCENARIO_DATA_STATUSES = (
    "calculated",
    "normatively_prohibited",
    "normative_review_required",
    "normative_data_missing",
    "landscape_data_missing",
    "not_checked",
)

# Приоритет при определении итогового нормативного состояния ячейки.
# Запрет нельзя компенсировать; неопределённость важнее условного статуса.
EFFECTIVE_NORM_ORDER = (
    "prohibited",
    "unclassified",
    "not_assessed",
    "conditional",
    "allowed",
    "no_known_restrictions",
)


def normalize(value: float, lower: float, upper: float, direction: str) -> float:
    """Нормализовать значение в [0; 1] с ограничением крайних значений."""

    span = float(upper) - float(lower)
    if span <= 0:
        raise ValueError("Верхняя граница должна быть больше нижней.")
    if direction == "direct":
        normalized = (float(value) - float(lower)) / span
    elif direction == "inverse":
        normalized = (float(upper) - float(value)) / span
    else:
        raise ValueError(f"Неизвестное направление нормализации: {direction!r}.")
    return min(1.0, max(0.0, normalized))


def weighted_index(
    values: Sequence[float],
    weights: Sequence[float],
    criteria: Sequence[Mapping[str, object]],
    *,
    development_direction: str,
) -> tuple[list[float], float]:
    """Рассчитать нормализованные критерии и взвешенный индекс."""

    if len(values) != 4:
        raise ValueError("Ожидаются четыре исходных критерия.")
    if len(weights) != 4:
        raise ValueError("Ожидаются четыре веса.")
    normalized: list[float] = []
    for value, weight, criterion in zip(values, weights, criteria):
        direction = str(criterion["direction"])
        if direction == "scenario":
            direction = development_direction
        normalized.append(
            normalize(
                value,
                float(criterion["lower"]),
                float(criterion["upper"]),
                direction,
            )
        )
    index = sum(weight * value for weight, value in zip(weights, normalized))
    return normalized, index


def classify_landscape(index_value: float) -> str:
    """Назначить класс чувствительности по правилу ver1."""

    if index_value <= 0.25:
        return "intensive_development"
    if index_value <= 0.50:
        return "extensive_development"
    if index_value <= 0.75:
        return "limited_development"
    return "preservation"


def combine_mode(norm_status: str, landscape_mode: str) -> str:
    """Совместить нормативный статус и ландшафтный класс."""

    if norm_status in {"allowed", "no_known_restrictions"}:
        return landscape_mode
    if norm_status == "conditional":
        if landscape_mode == "preservation":
            return "preservation"
        return "limited_development"
    raise ValueError(
        f"Нельзя совмещать чувствительность с нормативным статусом {norm_status!r}."
    )


def effective_norm_status(
    norm_status: str,
    *,
    prohibited_share: float,
    unclassified_share: float,
    not_assessed_share: float,
) -> str:
    """Вернуть итоговый нормативный статус с учётом долей пересечения.

    Это повторяет консервативное ветвление ver1: любая положительная доля
    запрета исключает ячейку; неопределённость и отсутствие оценки имеют
    приоритет над условным статусом.
    """

    if prohibited_share > TOLERANCE or norm_status == "prohibited":
        return "prohibited"
    if unclassified_share > TOLERANCE or norm_status == "unclassified":
        return "unclassified"
    if not_assessed_share > TOLERANCE or norm_status == "not_assessed":
        return "not_assessed"
    if norm_status not in NORM_STATUSES:
        return "unclassified"
    return norm_status


def expected_scenario_status(
    norm_status: str,
    *,
    prohibited_share: float,
    unclassified_share: float,
    not_assessed_share: float,
    has_all_criteria: bool,
) -> str:
    """Определить ожидаемое служебное состояние сценария для ячейки."""

    effective = effective_norm_status(
        norm_status,
        prohibited_share=prohibited_share,
        unclassified_share=unclassified_share,
        not_assessed_share=not_assessed_share,
    )
    if effective == "prohibited":
        return "normatively_prohibited"
    if effective == "unclassified":
        return "normative_review_required"
    if effective == "not_assessed":
        return "normative_data_missing"
    if effective not in {"allowed", "conditional", "no_known_restrictions"}:
        return "normative_review_required"
    if not has_all_criteria:
        return "landscape_data_missing"
    return "calculated"


def mode_counts(modes: Iterable[str]) -> dict[str, int]:
    """Посчитать значения режимов, сохраняя стабильный порядок известных кодов."""

    counts: dict[str, int] = {}
    for mode in modes:
        counts[str(mode)] = counts.get(str(mode), 0) + 1
    return counts
